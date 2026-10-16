// Oracle Arena — local control-plane server (the "world") + spectator view.
// Owns a PRIVATE directory (secret assignments, passwords, submitted binaries,
// scores) that bots never touch directly; everything is reached through this
// JSON API, scoped by a per-bot bearer token. Enforces one global clock:
// a hard build deadline, then an attack window, then the round ends.
//
// A separate, admin-keyed SPECTATOR surface (dashboard page + SSE stream + state
// snapshot) gives the operator a god-view: who accessed what, who built what,
// submissions, guesses, and the live leaderboard. Bots never see this.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { validateModule } from "../validator/validate.mjs";
import { fref } from "../validator/functions.mjs";
import { runExec } from "../sandbox/exec_runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const BUILD_MS = Number(process.env.BUILD_MS || 30 * 60_000);   // 30 min default
const ATTACK_MS = Number(process.env.ATTACK_MS || 60 * 60_000); // 60 min default
const ADMIN_KEY = process.env.ARENA_ADMIN_KEY || "dev-admin";
const PRIVATE_DIR = process.env.PRIVATE_DIR || join(HERE, ".private");
const LOCK_AT = Number(process.env.LOCK_AT || 5); // attempts that lock a binary
const START_SCORE = 10;
const SUBMIT_REWARD = Number(process.env.SUBMIT_REWARD || 10); // +points for a valid, on-time binary
const ROUNDS = Number(process.env.ROUNDS || 1);          // tournament length
const BREAK_MS = Number(process.env.BREAK_MS || 2 * 60_000); // study break between rounds

mkdirSync(join(PRIVATE_DIR, "binaries"), { recursive: true });

const rulesObj = JSON.parse(readFileSync(join(HERE, "..", "spec", "rules.json"), "utf8"));
// Deliberately omit the warm-up defense ladder and anything that would hint at
// HOW to harden a binary — bots must invent their own obfuscation.
const servedRules = JSON.stringify({
  competition: rulesObj.competition, version: rulesObj.version, summary: rulesObj.summary,
  arena: rulesObj.arena, protocol: rulesObj.protocol,
});
const abiDoc = readFileSync(join(HERE, "..", "spec", "abi.md"), "utf8");
const functionsDoc = JSON.parse(readFileSync(join(HERE, "..", "spec", "functions.json"), "utf8"));
const publicFunctions = { input_domain: functionsDoc.input_domain, functions: functionsDoc.functions };
const DASHBOARD = join(HERE, "dashboard.html");
const fnName = (id) => functionsDoc.functions[id]?.name ?? "?";

// --- state (lives only here; persisted to the private dir for inspection) ---
const agents = new Map();   // token -> agent
const byId = new Map();     // id -> agent
// phases: pending -> build -> verify -> attack -> ended
// build has a HARD absolute deadline (submissions after it are refused). verify
// is a processing window of variable length (the server checks each submission);
// attack is time-bound from the moment verification completes.
let startedAt = null;
let attackStartedAt = null;
let breakStartedAt = null;
let phaseState = "pending";
let round = 0;                 // 1-based; 0 = not started
let lastCompletedRound = 0;    // what /v1/study serves
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function now() { return Date.now(); }
function phase() { return phaseState; }
function clock() {
  const build_ends_at = phaseState === "build" && startedAt !== null ? startedAt + BUILD_MS : null;
  const attack_ends_at = phaseState === "attack" && attackStartedAt !== null ? attackStartedAt + ATTACK_MS : null;
  const break_ends_at = phaseState === "break" && breakStartedAt !== null ? breakStartedAt + BREAK_MS : null;
  let seconds_remaining = null; // time left in the CURRENT phase — your scarcest resource
  if (build_ends_at) seconds_remaining = Math.max(0, Math.round((build_ends_at - now()) / 1000));
  else if (attack_ends_at) seconds_remaining = Math.max(0, Math.round((attack_ends_at - now()) / 1000));
  else if (break_ends_at) seconds_remaining = Math.max(0, Math.round((break_ends_at - now()) / 1000));
  return { phase: phaseState, round, rounds_total: ROUNDS, now: now(),
           started_at: startedAt, build_ends_at, attack_ends_at, break_ends_at, seconds_remaining };
}

// Begin round n. reassign=false only for round 1 (agents keep the function they
// were registered with); later rounds hand everyone a FRESH function so the only
// thing that carries over is score and whatever technique they learned.
function beginRound(n, reassign) {
  round = n;
  for (const a of byId.values()) {
    if (reassign) a.functionId = Math.floor(Math.random() * 10);
    a.submitted = false; a.valid = false; a.verified = false; a.submission = null; a.binaryName = null;
    a.published = null; a.attempts = 0; a.locked = false; a.guessedBy = new Set(); a.iGuessed = new Set();
    a.roundStartScore = a.score; a.roundIdentified = 0; a.log = []; a.doneRound = false;
    if (reassign) emit("register", { actor: a.id, function_id: a.functionId, function_name: fnName(a.functionId), round: n });
  }
  startedAt = now(); attackStartedAt = null; breakStartedAt = null;
  phaseState = "build";
  emit("round", { round: n, rounds_total: ROUNDS });
  emit("phase", { phase: "build", round: n, rounds_total: ROUNDS });
  saveState();
}

// End of a round's attack window: archive each bot's thoughts + outcome so the
// study break can serve them, then open the break (or end the tournament).
function endAttack() {
  for (const a of byId.values()) {
    a.roundLogs.push({ round, thoughts: [...a.log], delta: a.score - a.roundStartScore, identified: a.roundIdentified, function_id: a.functionId });
  }
  lastCompletedRound = round;
  if (round < ROUNDS) {
    breakStartedAt = now(); phaseState = "break";
    emit("phase", { phase: "break", round, rounds_total: ROUNDS });
  } else {
    phaseState = "ended";
    emit("phase", { phase: "ended", round, rounds_total: ROUNDS });
  }
  saveState();
}
function saveState() {
  const snap = { clock: clock(), agents: [...byId.values()].map((a) => ({
    id: a.id, functionId: a.functionId, score: a.score, submitted: a.submitted,
    valid: a.valid, attempts: a.attempts, locked: a.locked })) };
  try { writeFileSync(join(PRIVATE_DIR, "state.json"), JSON.stringify(snap, null, 2)); } catch {}
}

// --- spectator event bus ---
const events = [];
let seq = 0;
const sseClients = new Set();
function emit(type, detail = {}) {
  const e = { seq: ++seq, t: now(), type, ...detail };
  events.push(e); if (events.length > 3000) events.shift();
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch {} }
}
function spectatorSnapshot() {
  return {
    clock: clock(), lock_at: LOCK_AT,
    functions: functionsDoc.functions.map((f) => ({ id: f.id, name: f.name })),
    agents: [...byId.values()].map((a) => ({
      id: a.id, brain: a.brain || "unknown", function_id: a.functionId, function_name: fnName(a.functionId),
      score: a.score, round_delta: a.score - (a.roundStartScore ?? a.score),
      submitted: a.submitted, valid: a.valid, verified: a.verified, locked: a.locked,
      attempts: a.attempts, last_thought: a.lastThought || null,
      thoughts: (a.log || []).slice(-80),
      i_guessed: [...a.iGuessed], guessed_by: [...a.guessedBy] })),
  };
}
const DOMAIN_MAX = 2147483647;
function sampleInputs() {
  const s = [[0, 0], [0, DOMAIN_MAX], [DOMAIN_MAX, 0], [DOMAIN_MAX, DOMAIN_MAX], [1, 1]];
  for (let i = 0; i < 12; i++) s.push([Math.floor(Math.random() * DOMAIN_MAX), Math.floor(Math.random() * DOMAIN_MAX)]);
  return s;
}
// verify a native/script submission by running it in the sandbox (CLI contract:
// `prog a b password` -> integer on stdout, or the line WRONG_PASSWORD).
async function verifyExec(fnId, s) {
  const inputs = sampleInputs();
  const pw = String(s.password);
  const ops = inputs.map(([a, b]) => [a, b, pw]);
  const wrong = inputs.slice(0, 3).map(([a, b]) => [a, b, pw + "_WRONG"]);
  const r = await runExec({ lang: s.lang, source: s.source, ops: ops.concat(wrong), timeoutMs: 25000, returnBinary: s.lang === "cpp" });
  if (!r.ok) return { ok: false, reason: r.stage === "compile" ? "compile failed: " + String(r.error || "").slice(0, 120) : (r.reason || r.error || "sandbox error") };
  const out = r.results || [];
  for (let i = 0; i < inputs.length; i++) {
    const [a, b] = inputs[i];
    const want = String(fref(fnId, BigInt(a), BigInt(b)));
    if (out[i] !== want) return { ok: false, reason: `output mismatch on (${a},${b}): got ${out[i]}, want ${want}` };
  }
  for (let i = 0; i < wrong.length; i++) {
    if (out[inputs.length + i] !== "WRONG_PASSWORD") return { ok: false, reason: `wrong password not rejected: got ${out[inputs.length + i]}` };
  }
  return { ok: true, binaryB64: r.binary_b64 || null };
}

// verify a complete prebuilt binary by running it in the sandbox (CLI contract).
async function verifyBinary(fnId, bytes, password) {
  const inputs = sampleInputs();
  const pw = String(password);
  const ops = inputs.map(([a, b]) => [a, b, pw]);
  const wrong = inputs.slice(0, 3).map(([a, b]) => [a, b, pw + "_WRONG"]);
  const r = await runExec({ lang: "binary", sourceBytes: bytes, ops: ops.concat(wrong), timeoutMs: 20000 });
  if (!r.ok) return { ok: false, reason: r.reason || r.error || "sandbox error" };
  const out = r.results || [];
  for (let i = 0; i < inputs.length; i++) {
    const [a, b] = inputs[i];
    const want = String(fref(fnId, BigInt(a), BigInt(b)));
    if (out[i] !== want) return { ok: false, reason: `output mismatch on (${a},${b}): got ${out[i]}, want ${want}` };
  }
  for (let i = 0; i < wrong.length; i++) {
    if (out[inputs.length + i] !== "WRONG_PASSWORD") return { ok: false, reason: `wrong password not rejected: got ${out[inputs.length + i]}` };
  }
  return { ok: true };
}

// verify each accepted submission after the build deadline, with visible pacing,
// then open the attack phase.
async function runVerification() {
  const subs = [...byId.values()].filter((a) => a.submitted && a.submission);
  emit("verify_start", { count: subs.length });
  for (const a of subs) {
    await sleep(500); // deliberate pacing so verification is observable
    const s = a.submission;
    let ok = false, reason = "", binaryB64 = null;
    if (s.functionId !== a.functionId) { reason = "declared function is not the one assigned"; }
    else if (s.kind === "binary") { const v = await verifyBinary(a.functionId, s.bytes, s.password); ok = v.ok; reason = v.reason || ""; }
    else if (s.kind === "exec") { const v = await verifyExec(a.functionId, s); ok = v.ok; reason = v.reason || ""; binaryB64 = v.binaryB64; }
    else { const v = await validateModule(s.bytes, a.functionId, String(s.password)); ok = v.ok; reason = v.reason || ""; }
    a.valid = ok; a.verified = true;
    if (ok) a.score += SUBMIT_REWARD; // reward a valid, on-time submission
    if (ok) {
      // publish the binary where one exists (wasm, submitted ELF, or C++ -> ELF)
      // so rivals must reverse-engineer it; interpreted scripts stay as source.
      let data;
      if (s.kind === "wasm") { a.published = { name: `${a.id}.wasm`, type: "application/wasm", kind: "wasm" }; data = Buffer.from(s.bytes); }
      else if (s.kind === "binary") { a.published = { name: `${a.id}.bin`, type: "application/octet-stream", kind: "elf" }; data = Buffer.from(s.bytes); }
      else if (s.lang === "cpp" && binaryB64) { a.published = { name: `${a.id}.bin`, type: "application/octet-stream", kind: "elf" }; data = Buffer.from(binaryB64, "base64"); }
      else { a.published = { name: `${a.id}.${s.lang === "python" ? "py" : "sh"}`, type: "text/plain", kind: s.lang }; data = Buffer.from(s.source, "utf8"); }
      writeFileSync(join(PRIVATE_DIR, "binaries", a.published.name), data);
    }
    emit("verify", { actor: a.id, ok, reason, reward: ok ? SUBMIT_REWARD : 0, score: a.score });
    saveState();
  }
  emit("verify_done", { valid: subs.filter((a) => a.valid).length });
  attackStartedAt = now();
  phaseState = "attack";
  emit("phase", { phase: "attack", round, rounds_total: ROUNDS });
}

// A round can close EARLY to save time: build ends once everyone has a
// submission on file; attack ends once every bot has either run out of reachable
// targets or declared itself done. The break is always its full length.
const allSubmitted = () => byId.size > 0 && [...byId.values()].every((a) => a.submitted);
const remainingTargets = (a) => [...byId.values()].filter((t) => t.valid && !t.locked && t.id !== a.id && !a.iGuessed.has(t.id));
const attackSettled = () => byId.size > 0 && [...byId.values()].every((a) => a.doneRound || remainingTargets(a).length === 0);

let verifying = false;
setInterval(() => {
  if (phaseState === "build" && startedAt !== null && !verifying && (now() >= startedAt + BUILD_MS || allSubmitted())) {
    phaseState = "verify"; emit("phase", { phase: "verify", round, rounds_total: ROUNDS });
    verifying = true; runVerification().finally(() => { verifying = false; });
  } else if (phaseState === "attack" && attackStartedAt !== null && (now() >= attackStartedAt + ATTACK_MS || attackSettled())) {
    endAttack();
  } else if (phaseState === "break" && breakStartedAt !== null && now() >= breakStartedAt + BREAK_MS) {
    beginRound(round + 1, true);
  }
}, 300).unref();

// --- tiny HTTP helpers ---
function send(res, code, body, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": type });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { resolve(null); } });
  });
}
function auth(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  return token ? agents.get(token) || null : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const m = req.method;
  const tok = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  const actorId = tok && agents.has(tok) ? agents.get(tok).id : "anon";

  // browsers auto-request this; answer it so it does not fall through to the
  // token gate and return a misleading 401 in the console.
  if (path === "/favicon.ico" && m === "GET") { res.writeHead(204, { "cache-control": "no-store" }); return res.end(); }

  // --- spectator surface (operator god-view; admin-keyed) ---
  // no-store so the browser never serves a stale copy of the live dashboard.
  if ((path === "/" || path === "/dashboard") && m === "GET") {
    try { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store, must-revalidate" }); return res.end(readFileSync(DASHBOARD)); }
    catch { return send(res, 500, { error: "dashboard.html missing" }); }
  }
  if (path === "/spectator/snapshot" && m === "GET") {
    if (url.searchParams.get("key") !== ADMIN_KEY) return send(res, 403, { error: "spectator key required" });
    return send(res, 200, spectatorSnapshot());
  }
  if (path === "/spectator/stream" && m === "GET") {
    if (url.searchParams.get("key") !== ADMIN_KEY) return send(res, 403, { error: "spectator key required" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    for (const e of events.slice(-250)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // --- admin (orchestrator only) ---
  if (path === "/admin/agents" && m === "POST") {
    if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) return send(res, 403, { error: "admin only" });
    const body = (await readBody(req)) || {};
    // either { count } (anonymous) or { brains: [label,...] } to label each bot's
    // brain for the SPECTATOR view (bots never see each other's brain labels).
    const brains = Array.isArray(body.brains) ? body.brains : null;
    const n = brains ? brains.length : (body.count || 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = `bot-${byId.size + 1}`;
      const token = randomBytes(16).toString("hex");
      const functionId = Math.floor(Math.random() * 10);
      const a = { id, token, functionId, brain: brains ? String(brains[i]) : "unknown",
                  score: START_SCORE, roundStartScore: START_SCORE, roundIdentified: 0,
                  submitted: false, valid: false, verified: false, submission: null, binaryName: null,
                  attempts: 0, locked: false, doneRound: false, guessedBy: new Set(), iGuessed: new Set(), log: [], roundLogs: [] };
      agents.set(token, a); byId.set(id, a);
      emit("register", { actor: id, function_id: functionId, function_name: fnName(functionId), brain: a.brain });
      out.push({ id, token, assigned_function_id: functionId });
    }
    saveState();
    return send(res, 200, out);
  }
  if (path === "/admin/start" && m === "POST") {
    if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) return send(res, 403, { error: "admin only" });
    beginRound(1, false); // round 1 keeps the functions assigned at registration
    return send(res, 200, clock());
  }

  // --- discovery (unauthenticated) ---
  if (path === "/v1/challenge" && m === "GET") {
    return send(res, 200, {
      you_are: "a participant in a capture-the-flag contest",
      authenticate: "send header 'Authorization: Bearer <your token>' on authed routes",
      how_to_play: [
        "You are secretly assigned ONE function id. GET /v1/me for your assigned_function_id; GET /v1/functions for what each id computes. Your assignment is RE-ASSIGNED every round.",
        "The contest runs for several ROUNDS (see round / rounds_total in /v1/state). Everyone starts at 10 points and score is CUMULATIVE across all rounds.",
        `Each round runs on one clock (GET /v1/state for phase, round, seconds_remaining). BUILD: produce a binary meeting the contract at /v1/abi that computes YOUR assigned function behind a password you choose, and submit it before the HARD deadline (late submissions are discarded; resubmitting replaces your entry). A binary that verifies honest earns you +${SUBMIT_REWARD} points — so submitting a valid binary every round matters. VERIFY: the server checks every submission. ATTACK: rival binaries become PUBLIC — GET /v1/targets, download each, work out its password and which function it computes, and guess (correct +2 to you / -2 to them; wrong the reverse; a binary locks after enough attempts, so move fast). Phases end as soon as everyone is finished — the build phase closes once all players have submitted, and the attack phase closes once every player has run out of targets or POSTed /v1/done to bow out — so do not dawdle.`,
        "Between rounds there is a 2-minute BREAK to strategize. The /v1/study endpoint is reachable only during that break.",
        "TIME is your scarcest resource — plan against seconds_remaining. Narrate your reasoning to /v1/log so it is visible. Keep playing every round until /v1/state shows phase \"ended\".",
      ],
      your_status: "/v1/me", rules_detail: "/v1/rules", functions: "/v1/functions", binary_contract: "/v1/abi", clock: "/v1/state",
      act: { submit_binary: "POST /v1/upload {wasm_base64, function_id, password}", find_targets: "GET /v1/targets",
             download_a_binary: "GET /v1/binary/{id}", guess: "POST /v1/guess {target, function_id}", note_progress: "POST /v1/log {msg}" },
      leaderboard: "/v1/leaderboard" });
  }
  if (path === "/v1/rules" && m === "GET") { emit("access", { actor: actorId, path }); return send(res, 200, servedRules, "application/json"); }
  if (path === "/v1/abi" && m === "GET") { emit("access", { actor: actorId, path }); return send(res, 200, abiDoc, "text/markdown"); }
  if (path === "/v1/functions" && m === "GET") { emit("access", { actor: actorId, path }); return send(res, 200, publicFunctions); }
  if (path === "/v1/state" && m === "GET") return send(res, 200, clock());
  if (path === "/v1/leaderboard" && m === "GET") {
    const rows = [...byId.values()].sort((a, b) => b.score - a.score)
      .map((a, i) => ({ rank: i + 1, id: a.id, model: a.brain || "unknown", score: a.score,
        round_delta: a.score - (a.roundStartScore ?? a.score), submitted: a.valid, attempts_against: a.attempts, locked: a.locked }));
    return send(res, 200, rows);
  }

  // --- authenticated ---
  const me = auth(req);
  if (!me) return send(res, 401, { error: "missing or invalid token" });

  if (path === "/v1/me" && m === "GET") {
    emit("access", { actor: me.id, path });
    return send(res, 200, { id: me.id, score: me.score, round, rounds_total: ROUNDS, assigned_function_id: me.functionId,
      submitted: me.submitted, valid: me.valid, locked: me.locked, attempts_against_me: me.attempts });
  }

  if (path === "/v1/log" && m === "POST") {
    const b = await readBody(req);
    const msg = String(b?.msg || "").slice(0, 280);
    me.lastThought = msg;
    me.log.push({ t: now(), round, msg });
    if (me.log.length > 300) me.log.shift();
    emit("bot", { actor: me.id, msg });
    return send(res, 200, { ok: true });
  }

  // declare yourself finished attacking this round — lets the round close early
  // (the attack phase ends once every bot is done or has no targets left).
  if (path === "/v1/done" && m === "POST") {
    if (phase() !== "attack") return send(res, 403, { error: `only during the attack phase (phase: ${phase()})` });
    me.doneRound = true;
    emit("bot", { actor: me.id, msg: "— declares its round complete —" });
    return send(res, 200, { ok: true });
  }

  // study break: read what every competitor did LAST round — their narrated
  // thoughts, their score change, and how often their function was cracked.
  // Keyed by bot id (anonymous); brains are never revealed to competitors.
  if (path === "/v1/study" && m === "GET") {
    if (phaseState !== "break" && phaseState !== "ended")
      return send(res, 403, { error: `study opens in the break between rounds (phase: ${phaseState})` });
    emit("access", { actor: me.id, path, note: `studied round ${lastCompletedRound}` });
    const bots = [...byId.values()].map((a) => {
      const last = a.roundLogs[a.roundLogs.length - 1];
      return { id: a.id, is_me: a.id === me.id, round_score_delta: last?.delta ?? 0,
        times_cracked: last?.identified ?? 0, total_score: a.score,
        thoughts: (last?.thoughts || []).map((e) => e.msg) };
    });
    return send(res, 200, { round: lastCompletedRound, rounds_total: ROUNDS, next_round: round + 1, bots });
  }

  if (path === "/v1/upload" && m === "POST") {
    // accept (and store) up to the hard deadline; legitimacy is checked in the verify phase
    if (phase() !== "build") { emit("submit", { actor: me.id, ok: false, reason: `phase ${phase()}` }); return send(res, 403, { error: `uploads closed (phase: ${phase()})` }); }
    const body = await readBody(req);
    if (!body || body.function_id === undefined || body.password === undefined)
      return send(res, 400, { error: "need { function_id, password, and one of: binary_base64 | wasm_base64 | (lang + source) }" });
    const password = String(body.password);
    if (body.wasm_base64) {
      const bytes = new Uint8Array(Buffer.from(body.wasm_base64, "base64"));
      me.submission = { kind: "wasm", bytes, functionId: body.function_id, password };
      emit("submit", { actor: me.id, ok: true, bytes: bytes.length, note: "wasm accepted; pending verification" });
    } else if (body.binary_base64) {
      const bytes = new Uint8Array(Buffer.from(body.binary_base64, "base64"));
      me.submission = { kind: "binary", bytes, functionId: body.function_id, password };
      emit("submit", { actor: me.id, ok: true, bytes: bytes.length, note: "binary accepted; pending verification" });
    } else if (body.source && body.lang) {
      const ext = body.lang === "cpp" ? "cpp" : body.lang === "python" ? "py" : "sh";
      me.submission = { kind: "exec", lang: String(body.lang), source: String(body.source), functionId: body.function_id, password };
      me.binaryName = `${me.id}.${ext}`;
      emit("submit", { actor: me.id, ok: true, bytes: String(body.source).length, note: `${body.lang} source accepted; pending verification` });
    } else {
      return send(res, 400, { error: "provide binary_base64, wasm_base64, or lang + source" });
    }
    me.submitted = true; me.valid = false; me.verified = false;
    saveState();
    return send(res, 200, { ok: true, id: me.id, status: "accepted; verified after the build deadline" });
  }

  if (path === "/v1/targets" && m === "GET") {
    if (phase() !== "attack") return send(res, 403, { error: `targets available in the attack phase only (phase: ${phase()})` });
    // note: not emitted to the feed — it is a high-frequency poll; binary downloads are the real recon signal
    const list = [...byId.values()].filter((a) => a.valid && a.id !== me.id && !a.locked && !me.iGuessed.has(a.id))
      .map((a) => ({ id: a.id, attempts: a.attempts, locked: a.locked, binary: `/v1/binary/${a.id}` }));
    return send(res, 200, list);
  }

  if (path.startsWith("/v1/binary/") && m === "GET") {
    if (phase() !== "attack") return send(res, 403, { error: "binaries published in the attack phase only" });
    const id = path.slice("/v1/binary/".length);
    const a = byId.get(id);
    if (!a || !a.valid || !a.published) return send(res, 404, { error: "no such binary" });
    emit("access", { actor: me.id, path, note: `downloaded ${id}'s ${a.published.kind}` });
    const buf = readFileSync(join(PRIVATE_DIR, "binaries", a.published.name));
    res.writeHead(200, { "content-type": a.published.type, "x-artifact-kind": a.published.kind });
    return res.end(buf);
  }

  if (path === "/v1/guess" && m === "POST") {
    if (phase() !== "attack") return send(res, 403, { error: "guessing is open in the attack phase only" });
    const body = await readBody(req);
    const target = byId.get(body?.target);
    const fid = body?.function_id;
    if (!target || !target.valid) return send(res, 404, { error: "no such target" });
    if (target.id === me.id) return send(res, 409, { error: "cannot guess your own binary" });
    if (target.locked) return send(res, 409, { error: "target is locked" });
    if (me.iGuessed.has(target.id)) return send(res, 409, { error: "you already guessed this target" });
    if (!Number.isInteger(fid) || fid < 0 || fid > 9) return send(res, 400, { error: "function_id must be 0..9" });

    me.iGuessed.add(target.id);
    target.attempts += 1;
    target.guessedBy.add(me.id);
    const correct = fid === target.functionId;
    if (correct) { me.score += 2; target.score -= 2; target.roundIdentified = (target.roundIdentified || 0) + 1; } else { me.score -= 2; target.score += 2; }
    if (target.attempts >= LOCK_AT) target.locked = true;
    saveState();
    emit("guess", { actor: me.id, target: target.id, function_id: fid, function_name: fnName(fid),
      correct, guesser_score: me.score, target_score: target.score });
    if (target.locked) emit("lock", { target: target.id, attempts: target.attempts });
    return send(res, 200, { correct, guesser_delta: correct ? 2 : -2, target_delta: correct ? -2 : 2,
      target_locked_now: target.locked, your_score: me.score });
  }

  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[arena] http://localhost:${PORT}  dashboard: /?key=${ADMIN_KEY}  rounds=${ROUNDS} build=${BUILD_MS}ms attack=${ATTACK_MS}ms break=${BREAK_MS}ms lock_at=${LOCK_AT}`);
});
