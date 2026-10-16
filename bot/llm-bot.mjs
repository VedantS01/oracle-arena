// LLM-backed bot brain. Handed only a thin prompt (you're in a CTF, here's the
// base URL + token) and a small tool set; it must DISCOVER the rules by calling
// the API and reason its way to a strategy. Driven by a local Ollama model, so
// different models = bots of different intelligence. Its plain-text reasoning is
// posted live to the spectator feed (POST /v1/log) so you can watch it think.
//
// Env: ARENA_URL, ARENA_TOKEN, BOT_ID, BOT_WORKSPACE, ASSEMBLY_DIR,
//      OLLAMA_URL (default http://localhost:11434/v1), OLLAMA_MODEL
import { buildBinary } from "./build-binary.mjs";
import { mkdirSync } from "node:fs";

const URL_ = process.env.ARENA_URL;
const TOKEN = process.env.ARENA_TOKEN;
const WORKSPACE = process.env.BOT_WORKSPACE;
const ASSEMBLY_DIR = process.env.ASSEMBLY_DIR;
const OLLAMA = (process.env.OLLAMA_URL || "http://localhost:11434/v1").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
const WRONG = -(2n ** 63n);
const MAX_STEPS = Number(process.env.LLM_MAX_STEPS || 32);

mkdirSync(WORKSPACE, { recursive: true });
const log = (...a) => console.log(`[${process.env.BOT_ID || "llm"}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- arena API ---
async function arena(path, opts = {}) {
  const r = await fetch(URL_ + path, { ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(opts.headers || {}) } });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/wasm") ? new Uint8Array(await r.arrayBuffer())
             : ct.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body };
}
async function postThought(msg) {
  const t = String(msg).replace(/\s+/g, " ").trim().slice(0, 280);
  if (t) { try { await arena("/v1/log", { method: "POST", body: JSON.stringify({ msg: t }) }); } catch {} log("💭", t); }
}

// --- reverse-engineering toolkit the bot "has installed" ---
function extractStrings(bytes, min = 3) {
  const out = new Set(); let cur = "";
  for (const b of bytes) { if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
    else { if (cur.length >= min) out.add(cur); cur = ""; } }
  if (cur.length >= min) out.add(cur);
  for (const s of [...out]) for (let i = 0; i < s.length; i++) for (let j = i + min; j <= s.length; j++) out.add(s.slice(i, j));
  return [...out];
}
async function crack(bytes) {
  let ex; try { ex = (await WebAssembly.instantiate(bytes, {})).instance.exports; } catch { return null; }
  const { memory, pwd_ptr, run } = ex;
  if (typeof run !== "function" || typeof pwd_ptr !== "function") return null;
  const call = (pw, a, b) => { const ptr = Number(pwd_ptr()); const p = new TextEncoder().encode(pw);
    new Uint8Array(memory.buffer, ptr, p.length).set(p); return run(a, b, p.length); };
  for (const cand of extractStrings(bytes)) { try { if (call(cand, 13n, 7n) !== WRONG) {
    const probes = [[6n, 10n], [12n, 10n], [9n, 5n], [8n, 3n], [14n, 6n], [13n, 13n]];
    return { password: cand, samples: probes.map(([a, b]) => ({ a: a.toString(), b: b.toString(), out: call(cand, a, b).toString() })) };
  } } catch {} }
  return null;
}

// --- tools exposed to the model ---
const tools = [
  { type: "function", function: { name: "api_get", description: "HTTP GET a path on the arena and return the JSON response.",
    parameters: { type: "object", properties: { path: { type: "string", description: "e.g. /v1/challenge, /v1/rules, /v1/functions, /v1/me, /v1/state, /v1/targets, /v1/leaderboard" } }, required: ["path"] } } },
  { type: "function", function: { name: "build_and_submit", description: "Build YOUR password-locked binary for the given function id and submit it. Only valid during the build phase.",
    parameters: { type: "object", properties: { function_id: { type: "integer" }, password: { type: "string" } }, required: ["function_id", "password"] } } },
  { type: "function", function: { name: "analyze_target", description: "Download a rival's binary and attempt to recover its password and sample input/output pairs. Returns cracked=false if it resists.",
    parameters: { type: "object", properties: { target_id: { type: "string" } }, required: ["target_id"] } } },
  { type: "function", function: { name: "guess", description: "Guess a target's hidden function id (0-9). Correct = +2 to you / -2 to them; wrong = the reverse.",
    parameters: { type: "object", properties: { target_id: { type: "string" }, function_id: { type: "integer" } }, required: ["target_id", "function_id"] } } },
];

let submitted = false;
async function execTool(name, args) {
  try {
    if (name === "api_get") { const r = await arena(args.path); return { status: r.status, body: r.body }; }
    if (name === "build_and_submit") {
      const wasm = await buildBinary({ workspaceDir: WORKSPACE, assemblyDir: ASSEMBLY_DIR, functionId: args.function_id, password: String(args.password) });
      const r = await arena("/v1/upload", { method: "POST", body: JSON.stringify({ wasm_base64: Buffer.from(wasm).toString("base64"), function_id: args.function_id, password: String(args.password) }) });
      if (r.body?.ok) submitted = true;
      return { status: r.status, body: r.body };
    }
    if (name === "analyze_target") {
      const dl = await arena(`/v1/binary/${args.target_id}`);
      if (!(dl.body instanceof Uint8Array)) return { cracked: false, note: `could not download (${dl.status})` };
      const res = await crack(dl.body);
      return res ? { cracked: true, password: res.password, samples: res.samples } : { cracked: false, note: "password not recovered" };
    }
    if (name === "guess") { const r = await arena("/v1/guess", { method: "POST", body: JSON.stringify({ target: args.target_id, function_id: args.function_id }) }); return { status: r.status, body: r.body }; }
    return { error: "unknown tool" };
  } catch (e) { return { error: String(e.message || e) }; }
}

// Many local models (qwen2.5-coder included) emit tool calls as JSON in the text
// instead of native tool_calls. Pull balanced {...} objects out of the content.
function jsonObjects(text) {
  const out = [];
  if (!text) return out;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") { depth--; if (depth === 0) { try { out.push(JSON.parse(text.slice(i, j + 1))); } catch {} i = j; break; } }
    }
  }
  return out;
}

// Collect tool calls from native tool_calls AND from JSON embedded in content
// (Ollama/qwen usually does the latter). Per tool name keep the most-populated
// args, so a half-parsed empty-arg native call doesn't shadow the real one.
function toolCallsFrom(msg) {
  const raw = [];
  for (const tc of msg.tool_calls || []) {
    let args = {}; const a = tc.function?.arguments;
    try { args = typeof a === "string" ? JSON.parse(a || "{}") : (a || {}); } catch {}
    if (tc.function?.name) raw.push({ name: tc.function.name, args });
  }
  for (const o of jsonObjects(msg.content || "")) {
    if (typeof o.name === "string") raw.push({ name: o.name, args: (o.arguments && typeof o.arguments === "object") ? o.arguments : (o.parameters || {}) });
  }
  const byName = new Map();
  for (const c of raw) { const p = byName.get(c.name); if (!p || Object.keys(c.args).length > Object.keys(p.args).length) byName.set(c.name, c); }
  return [...byName.values()];
}

// --- Ollama chat ---
async function chat(messages) {
  const r = await fetch(`${OLLAMA}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.4, stream: false }) });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message ?? {};
}

const SYSTEM = `You are an autonomous competitor in a capture-the-flag programming contest, identified as ${process.env.BOT_ID}.
Your API token is already configured; the arena base URL is ${URL_}.
You do NOT yet know the rules. Discover them: call api_get("/v1/challenge") first, then follow where it points (/v1/rules, /v1/functions, /v1/me). Work out what you must do and do it to maximize your score.
Always explain your reasoning in one or two short plain-text sentences BEFORE calling a tool — your thoughts are shown live to spectators. Be decisive and keep acting until the round ends.`;

const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: "Begin. Discover the challenge and play to win." }];

await postThought("waking up; going to read the challenge endpoint.");
for (let step = 0; step < MAX_STEPS; step++) {
  let msg;
  try { msg = await chat(messages); }
  catch (e) { log("chat error:", e.message); await sleep(1500); continue; }

  // narrate the reasoning (the part before any inline tool-call JSON)
  const thought = (msg.content || "").split(/\{\s*"name"/)[0].trim();
  if (thought) await postThought(thought);
  messages.push({ role: "assistant", content: msg.content || "" });

  const calls = toolCallsFrom(msg);
  if (calls.length) {
    for (const c of calls) {
      const result = await execTool(c.name, c.args);
      log("🔧", c.name, JSON.stringify(c.args).slice(0, 80), "->", JSON.stringify(result).slice(0, 90));
      messages.push({ role: "user", content: `Result of ${c.name}(${JSON.stringify(c.args)}): ${JSON.stringify(result).slice(0, 2500)}` });
    }
    continue;
  }

  // no action this turn: manage the clock without burning calls
  const st = (await arena("/v1/state")).body;
  if (st.phase === "ended") break;
  if ((st.phase === "build" || st.phase === "verify") && submitted) { await sleep(2500); messages.push({ role: "user", content: "You have submitted. The attack phase has not opened yet (submissions are being verified). Wait, then continue." }); continue; }
  messages.push({ role: "user", content: `No tool was called. Current phase: ${st.phase}. Keep playing to maximize your score (submit a binary in build; find targets and guess in attack).` });
}
await postThought("round over; standing down.");
log("done.");
