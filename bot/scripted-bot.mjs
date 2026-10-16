// Reference scripted bot ("brain"). Deterministic: proves the whole loop end to
// end without an LLM, now across a multi-round tournament. Each round:
//   DEFEND  build a baseline locked binary of my (freshly re-assigned) function.
//   ATTACK  for each rival: download, crack (crack.mjs), identify, guess.
// It does not learn between rounds — it is the fixed yardstick the thinking
// bots are measured against.
//
// Env: ARENA_URL, ARENA_TOKEN, BOT_WORKSPACE, ASSEMBLY_DIR
import { buildBinary } from "./build-binary.mjs";
import { fetchAndCrack } from "./crack.mjs";
import { mkdirSync } from "node:fs";

const URL_ = process.env.ARENA_URL;
const TOKEN = process.env.ARENA_TOKEN;
const WORKSPACE = process.env.BOT_WORKSPACE;
const ASSEMBLY_DIR = process.env.ASSEMBLY_DIR;

mkdirSync(WORKSPACE, { recursive: true });
const log = (...a) => console.log(`[${process.env.BOT_ID || "bot"}]`, ...a);

async function api(path, opts = {}) {
  const r = await fetch(URL_ + path, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(opts.headers || {}) },
  });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/wasm") ? new Uint8Array(await r.arrayBuffer())
             : ct.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => (await api("/v1/state")).body;

// --- DEFEND: build + submit this round's assigned function ---
async function defend(roundNo) {
  const me = (await api("/v1/me")).body;
  log(`round ${roundNo}: assigned function ${me.assigned_function_id}; building.`);
  const password = "pw-" + Math.random().toString(36).slice(2, 10);
  const wasm = await buildBinary({ workspaceDir: WORKSPACE, assemblyDir: ASSEMBLY_DIR, functionId: me.assigned_function_id, password });
  const up = await api("/v1/upload", { method: "POST", body: JSON.stringify({
    wasm_base64: Buffer.from(wasm).toString("base64"), function_id: me.assigned_function_id, password }) });
  log(up.body?.ok ? `round ${roundNo}: submitted.` : `round ${roundNo}: upload rejected: ${JSON.stringify(up.body)}`);
}

// --- ATTACK: crack every reachable target until the window closes ---
async function attack(roundNo) {
  const tried = new Set();
  for (;;) {
    const s = await state();
    if (s.phase !== "attack" || s.round !== roundNo) break;
    const targets = (await api("/v1/targets")).body;
    const fresh = (Array.isArray(targets) ? targets : []).filter((t) => !tried.has(t.id));
    for (const t of fresh) {
      tried.add(t.id);
      const res = await fetchAndCrack(URL_, TOKEN, t.id);
      if (!res || res.functionId === null) { log(`round ${roundNo}: could not identify ${t.id}; skipping.`); continue; }
      const g = await api("/v1/guess", { method: "POST", body: JSON.stringify({ target: t.id, function_id: res.functionId }) });
      if (g.status === 200) log(`round ${roundNo}: ${t.id} = fn ${res.functionId} -> ${g.body.correct ? "CORRECT +2" : "wrong -2"} (score ${g.body.your_score})`);
    }
    // nothing new to try: bow out so the round can close early
    if (fresh.length === 0) { await api("/v1/done", { method: "POST" }); log(`round ${roundNo}: nothing left to crack; declaring done.`); break; }
    await sleep(600);
  }
}

// --- tournament loop ---
let builtRound = 0, attackedRound = 0;
for (;;) {
  const s = await state();
  if (s.phase === "ended") break;
  if (s.phase === "build" && s.round > builtRound) { builtRound = s.round; await defend(s.round); }
  else if (s.phase === "attack" && s.round > attackedRound) { attackedRound = s.round; await attack(s.round); }
  else await sleep(600);
}
log("tournament over.");
