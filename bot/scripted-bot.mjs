// Reference scripted bot ("brain"). Deliberately simple and deterministic: it
// proves the whole loop end to end without an LLM. Strategy:
//   DEFEND  build a baseline locked binary of my assigned function and submit it.
//   ATTACK  for each rival: download, scan the bytes for its embedded password
//           (baseline binaries store it in cleartext), unlock, probe to identify
//           the function, then guess. Never blind-guess (the EV is negative).
//
// Env: ARENA_URL, ARENA_TOKEN, BOT_WORKSPACE, ASSEMBLY_DIR
import { buildBinary } from "./build-binary.mjs";
import { fetchAndCrack } from "./crack.mjs";
import { mkdirSync } from "node:fs";

const URL_ = process.env.ARENA_URL;
const TOKEN = process.env.ARENA_TOKEN;
const WORKSPACE = process.env.BOT_WORKSPACE;
const ASSEMBLY_DIR = process.env.ASSEMBLY_DIR;
const WRONG = -(2n ** 63n);

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
async function waitFor(pred, stepMs = 500) {
  for (;;) { const s = (await api("/v1/state")).body; if (pred(s)) return s; await sleep(stepMs); }
}

// --- discover + defend ---
const me = (await api("/v1/me")).body;
log(`I am ${me.id}; assigned function ${me.assigned_function_id}. Reading the rules...`);
await api("/v1/rules"); await api("/v1/functions"); // a real agent would parse these

const password = "pw-" + Math.random().toString(36).slice(2, 10);
const wasm = await buildBinary({ workspaceDir: WORKSPACE, assemblyDir: ASSEMBLY_DIR,
  functionId: me.assigned_function_id, password });
await waitFor((s) => s.phase !== "pending"); // the clock may not have started yet
const up = await api("/v1/upload", { method: "POST", body: JSON.stringify({
  wasm_base64: Buffer.from(wasm).toString("base64"), function_id: me.assigned_function_id, password }) });
log(up.body.ok ? "binary submitted and validated." : `upload rejected: ${JSON.stringify(up.body)}`);

// --- wait for the attack phase ---
await waitFor((s) => s.phase === "attack" || s.phase === "ended");

// --- attack --- (crack WASM in-process, ELF/scripts in the sandbox; see crack.mjs)
const tried = new Set();
for (;;) {
  const s = (await api("/v1/state")).body;
  if (s.phase === "ended") break;
  const targets = (await api("/v1/targets")).body;
  const fresh = (Array.isArray(targets) ? targets : []).filter((t) => !tried.has(t.id));
  if (fresh.length === 0) { log("no untried targets left; done attacking."); break; }
  for (const t of fresh) {
    tried.add(t.id);
    const res = await fetchAndCrack(URL_, TOKEN, t.id);
    if (!res || res.functionId === null) { log(`could not crack/identify ${t.id}; skipping (negative EV to guess blind).`); continue; }
    const g = await api("/v1/guess", { method: "POST", body: JSON.stringify({ target: t.id, function_id: res.functionId }) });
    if (g.status === 200) log(`guessed ${t.id} = fn ${res.functionId} -> ${g.body.correct ? "CORRECT +2" : "wrong -2"} (score ${g.body.your_score})`);
  }
  await sleep(800);
}
log("round over.");
