// LLM-backed bot brain. Handed only a thin prompt (you're in a CTF, here's the
// base URL + token) and a small tool set; it must DISCOVER the rules by calling
// the API and reason its way to a strategy. Driven by a local Ollama model, so
// different models = bots of different intelligence. Its plain-text reasoning is
// posted live to the spectator feed (POST /v1/log) so you can watch it think.
//
// Env: ARENA_URL, ARENA_TOKEN, BOT_ID, BOT_WORKSPACE, ASSEMBLY_DIR,
//      OLLAMA_URL (default http://localhost:11434/v1), OLLAMA_MODEL
import { buildBinary } from "./build-binary.mjs";
import { probeTarget, reconTarget } from "./recon.mjs";
import { mkdirSync } from "node:fs";

const URL_ = process.env.ARENA_URL;
const TOKEN = process.env.ARENA_TOKEN;
const WORKSPACE = process.env.BOT_WORKSPACE;
const ASSEMBLY_DIR = process.env.ASSEMBLY_DIR;
// Any OpenAI-compatible chat endpoint: local Ollama, Ollama Cloud (via the local
// proxy), or a hosted provider like Anthropic's compat endpoint with an API key.
const LLM_URL = (process.env.LLM_URL || process.env.OLLAMA_URL || "http://localhost:11434/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
const LLM_API_KEY = process.env.LLM_API_KEY || "";

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

// No canned cracker: the model must reverse-engineer targets itself using the two
// raw primitives below (probe_target / recon_target), reasoning over what it sees.

// --- tools exposed to the model ---
const tools = [
  { type: "function", function: { name: "api_get", description: "HTTP GET a path on the arena and return the JSON response.",
    parameters: { type: "object", properties: { path: { type: "string", description: "e.g. /v1/challenge, /v1/rules, /v1/functions, /v1/me, /v1/state, /v1/targets, /v1/leaderboard" } }, required: ["path"] } } },
  { type: "function", function: { name: "build_and_submit", description: "Build YOUR password-locked binary for the given function id and submit it. Only valid during the build phase.",
    parameters: { type: "object", properties: { function_id: { type: "integer" }, password: { type: "string" } }, required: ["function_id", "password"] } } },
  { type: "function", function: { name: "probe_target", description: "Run a rival's published binary with inputs YOU choose and see exactly what it prints. Each case runs `target a b password`; it prints WRONG_PASSWORD until you supply the right password, then the function's output. Use this to find the password and to deduce the hidden function from input/output behaviour.",
    parameters: { type: "object", properties: { target_id: { type: "string" }, cases: { type: "array", items: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" }, password: { type: "string" } }, required: ["a", "b", "password"] } } }, required: ["target_id", "cases"] } } },
  { type: "function", function: { name: "recon_target", description: "Download a rival's binary and run ONE shell command against it inside a locked sandbox. The binary is at ./target. Available tools: strings, objdump, nm, readelf, gdb, ltrace, strace, xxd, gcc, g++, python3. Returns the command's raw stdout/stderr. Example cmd: \"strings target | grep -i pass\" or \"objdump -d target | less\".",
    parameters: { type: "object", properties: { target_id: { type: "string" }, cmd: { type: "string" } }, required: ["target_id", "cmd"] } } },
  { type: "function", function: { name: "guess", description: "Guess a target's hidden function id (0-9). Correct = +2 to you / -2 to them; wrong = the reverse.",
    parameters: { type: "object", properties: { target_id: { type: "string" }, function_id: { type: "integer" } }, required: ["target_id", "function_id"] } } },
];

let submittedRound = 0; // the round number we last submitted in
let curRound = 0;       // updated by the loop each iteration
async function execTool(name, args) {
  try {
    if (name === "api_get") { const r = await arena(args.path); return { status: r.status, body: r.body }; }
    if (name === "build_and_submit") {
      const wasm = await buildBinary({ workspaceDir: WORKSPACE, assemblyDir: ASSEMBLY_DIR, functionId: args.function_id, password: String(args.password) });
      const r = await arena("/v1/upload", { method: "POST", body: JSON.stringify({ wasm_base64: Buffer.from(wasm).toString("base64"), function_id: args.function_id, password: String(args.password) }) });
      if (r.body?.ok) submittedRound = curRound;
      return { status: r.status, body: r.body };
    }
    if (name === "probe_target") {
      const cases = Array.isArray(args.cases) ? args.cases : [];
      const outputs = await probeTarget(URL_, TOKEN, args.target_id, cases);
      return outputs ? { outputs } : { error: "could not run target" };
    }
    if (name === "recon_target") {
      const r = await reconTarget(URL_, TOKEN, args.target_id, String(args.cmd || ""));
      return r ? { rc: r.rc, stdout: r.stdout, stderr: r.stderr, error: r.error } : { error: "could not run recon" };
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
  const headers = { "content-type": "application/json", ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}) };
  const r = await fetch(`${LLM_URL}/chat/completions`, { method: "POST", headers,
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.4, stream: false }) });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message ?? {};
}

const SYSTEM = `You are an autonomous competitor in a capture-the-flag programming contest, identified as ${process.env.BOT_ID}.
Your API token is already configured; the arena base URL is ${URL_}.
You do NOT yet know the rules. Discover them: call api_get("/v1/challenge") first, then follow where it points (/v1/rules, /v1/functions, /v1/me, /v1/state). Work out what you must do and do it to maximize your score.
Always explain your reasoning in one or two short plain-text sentences BEFORE calling a tool — your thoughts are shown live to spectators. Be decisive and keep acting until the contest ends.`;

const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: "Begin. Discover the challenge and play to win." }];

// factual clock update injected when the phase or round changes — just surfaces
// what /v1/state already says; what to DO about it is for the model to decide.
function phaseNote(st) {
  return `The clock advanced — phase: ${st.phase}, round ${st.round}/${st.rounds_total}, seconds_remaining: ${st.seconds_remaining}.`;
}

// scale the step budget to the tournament length
const st0 = (await arena("/v1/state")).body;
const ROUNDS = Math.max(1, st0.rounds_total || 1);
const MAX_STEPS = Number(process.env.LLM_MAX_STEPS || 32 * ROUNDS);

await postThought("waking up; going to read the challenge endpoint.");
let lastPhase = "", lastRound = 0;
for (let step = 0; step < MAX_STEPS; step++) {
  const st = (await arena("/v1/state")).body;
  if (st.phase === "ended") break;
  curRound = st.round;
  // announce a phase or round change to the model
  if (st.phase !== lastPhase || st.round !== lastRound) {
    const note = phaseNote(st);
    if (note) messages.push({ role: "user", content: note });
    lastPhase = st.phase; lastRound = st.round;
  }
  // nothing to do right now: wait without burning an LLM call
  if (st.phase === "verify" || (st.phase === "build" && submittedRound === st.round)) { await sleep(2500); continue; }

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
  // no tool this turn
  messages.push({ role: "user", content: `No tool was called. Current phase: ${st.phase}, round ${st.round}/${st.rounds_total}. Act now to maximize your cumulative score.` });
}
await postThought("contest over; standing down.");
log("done.");
