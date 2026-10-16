// Reference scripted bot ("brain"). Deliberately simple and deterministic: it
// proves the whole loop end to end without an LLM. Strategy:
//   DEFEND  build a baseline locked binary of my assigned function and submit it.
//   ATTACK  for each rival: download, scan the bytes for its embedded password
//           (baseline binaries store it in cleartext), unlock, probe to identify
//           the function, then guess. Never blind-guess (the EV is negative).
//
// Env: ARENA_URL, ARENA_TOKEN, BOT_WORKSPACE, ASSEMBLY_DIR
import { buildBinary } from "./build-binary.mjs";
import { fref } from "../validator/functions.mjs";
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

// --- attack ---
function extractStrings(bytes, min = 3) {
  const out = new Set(); let cur = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
    else { if (cur.length >= min) out.add(cur); cur = ""; }
  }
  if (cur.length >= min) out.add(cur);
  // also add contiguous sub-runs so an adjacent-data merge still yields the pw
  for (const s of [...out]) for (let i = 0; i < s.length; i++) for (let j = i + min; j <= s.length; j++) out.add(s.slice(i, j));
  return [...out];
}
async function crackAndIdentify(bytes) {
  let ex;
  try { ex = (await WebAssembly.instantiate(bytes, {})).instance.exports; } catch { return null; }
  const { memory, pwd_ptr, run } = ex;
  if (typeof run !== "function" || typeof pwd_ptr !== "function") return null;
  const call = (pw, a, b) => {
    const ptr = Number(pwd_ptr()); const p = new TextEncoder().encode(pw);
    new Uint8Array(memory.buffer, ptr, p.length).set(p);
    return run(a, b, p.length);
  };
  // find a password that unlocks (output != sentinel)
  let pw = null;
  for (const cand of extractStrings(bytes)) {
    try { if (call(cand, 13n, 7n) !== WRONG) { pw = cand; break; } } catch {}
  }
  if (pw === null) return null; // couldn't crack (hardened) -> don't guess
  // identify the function by probing
  // varied inputs (overlapping bits, carries, a big one) separate all 10 distinct ops
  const probes = [[6n, 10n], [12n, 10n], [9n, 5n], [8n, 3n], [14n, 6n], [255n, 2n], [1000000000n, 7n], [13n, 13n]];
  let cands = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (const [a, b] of probes) {
    const got = call(pw, a, b);
    cands = cands.filter((id) => { try { return fref(id, a, b) === got; } catch { return false; } });
    if (cands.length <= 1) break;
  }
  return cands.length === 1 ? cands[0] : null;
}

const tried = new Set();
for (;;) {
  const s = (await api("/v1/state")).body;
  if (s.phase === "ended") break;
  const targets = (await api("/v1/targets")).body;
  const fresh = (Array.isArray(targets) ? targets : []).filter((t) => !tried.has(t.id));
  if (fresh.length === 0) { log("no untried targets left; done attacking."); break; }
  for (const t of fresh) {
    tried.add(t.id);
    const dl = await api(`/v1/binary/${t.id}`);
    if (!(dl.body instanceof Uint8Array)) continue;
    const fid = await crackAndIdentify(dl.body);
    if (fid === null) { log(`could not crack ${t.id}; skipping (negative EV to guess blind).`); continue; }
    const g = await api("/v1/guess", { method: "POST", body: JSON.stringify({ target: t.id, function_id: fid }) });
    if (g.status === 200) log(`guessed ${t.id} = fn ${fid} -> ${g.body.correct ? "CORRECT +2" : "wrong -2"} (score ${g.body.your_score})`);
  }
  await sleep(800);
}
log("round over.");
