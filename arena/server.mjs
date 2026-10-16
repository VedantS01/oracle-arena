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

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const BUILD_MS = Number(process.env.BUILD_MS || 30 * 60_000);   // 30 min default
const ATTACK_MS = Number(process.env.ATTACK_MS || 60 * 60_000); // 60 min default
const ADMIN_KEY = process.env.ARENA_ADMIN_KEY || "dev-admin";
const PRIVATE_DIR = process.env.PRIVATE_DIR || join(HERE, ".private");
const LOCK_AT = Number(process.env.LOCK_AT || 5); // attempts that lock a binary
const START_SCORE = 10;

mkdirSync(join(PRIVATE_DIR, "binaries"), { recursive: true });

const rules = readFileSync(join(HERE, "..", "spec", "rules.json"), "utf8");
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
let phaseState = "pending";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function now() { return Date.now(); }
function phase() { return phaseState; }
function clock() {
  return {
    phase: phaseState, now: now(), started_at: startedAt,
    build_ends_at: startedAt === null ? null : startedAt + BUILD_MS,
    attack_ends_at: attackStartedAt === null ? null : attackStartedAt + ATTACK_MS,
  };
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
      id: a.id, function_id: a.functionId, function_name: fnName(a.functionId),
      score: a.score, submitted: a.submitted, valid: a.valid, verified: a.verified, locked: a.locked,
      attempts: a.attempts, last_thought: a.lastThought || null,
      i_guessed: [...a.iGuessed], guessed_by: [...a.guessedBy] })),
  };
}
// verify each accepted submission after the build deadline, with visible pacing,
// then open the attack phase.
async function runVerification() {
  const subs = [...byId.values()].filter((a) => a.submitted && a.submission);
  emit("verify_start", { count: subs.length });
  for (const a of subs) {
    await sleep(500); // deliberate pacing so verification is observable
    const s = a.submission;
    let ok = false, reason = "";
    if (s.functionId !== a.functionId) { reason = "declared function is not the one assigned"; }
    else { const v = await validateModule(s.bytes, a.functionId, String(s.password)); ok = v.ok; reason = v.reason || ""; }
    a.valid = ok; a.verified = true;
    if (ok) writeFileSync(join(PRIVATE_DIR, "binaries", a.binaryName), Buffer.from(s.bytes));
    emit("verify", { actor: a.id, ok, reason });
    saveState();
  }
  emit("verify_done", { valid: subs.filter((a) => a.valid).length });
  attackStartedAt = now();
  phaseState = "attack";
  emit("phase", { phase: "attack" });
}

let verifying = false;
setInterval(() => {
  if (phaseState === "build" && startedAt !== null && now() >= startedAt + BUILD_MS && !verifying) {
    phaseState = "verify"; emit("phase", { phase: "verify" });
    verifying = true; runVerification().finally(() => { verifying = false; });
  } else if (phaseState === "attack" && attackStartedAt !== null && now() >= attackStartedAt + ATTACK_MS) {
    phaseState = "ended"; emit("phase", { phase: "ended" });
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

  // --- spectator surface (operator god-view; admin-keyed) ---
  if ((path === "/" || path === "/dashboard") && m === "GET") {
    try { res.writeHead(200, { "content-type": "text/html" }); return res.end(readFileSync(DASHBOARD)); }
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
    const { count } = (await readBody(req)) || {};
    const out = [];
    for (let i = 0; i < (count || 0); i++) {
      const id = `bot-${byId.size + 1}`;
      const token = randomBytes(16).toString("hex");
      const functionId = Math.floor(Math.random() * 10);
      const a = { id, token, functionId, score: START_SCORE, submitted: false, valid: false, verified: false,
                  submission: null, binaryName: null, attempts: 0, locked: false, guessedBy: new Set(), iGuessed: new Set() };
      agents.set(token, a); byId.set(id, a);
      emit("register", { actor: id, function_id: functionId, function_name: fnName(functionId) });
      out.push({ id, token, assigned_function_id: functionId });
    }
    saveState();
    return send(res, 200, out);
  }
  if (path === "/admin/start" && m === "POST") {
    if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) return send(res, 403, { error: "admin only" });
    startedAt = now(); phaseState = "build"; emit("phase", { phase: "build" }); saveState();
    return send(res, 200, clock());
  }

  // --- discovery (unauthenticated) ---
  if (path === "/v1/challenge" && m === "GET") {
    return send(res, 200, {
      you_are: "a participant in a capture-the-flag reverse-engineering contest",
      authenticate: "send header 'Authorization: Bearer <your token>' on authed routes",
      learn_the_rules: "/v1/rules (machine-readable) and /v1/functions (the function pool)",
      your_status: "/v1/me", clock: "/v1/state",
      act: { submit_binary: "POST /v1/upload", find_targets: "GET /v1/targets",
             download_a_binary: "GET /v1/binary/{id}", guess: "POST /v1/guess", note_progress: "POST /v1/log" },
      leaderboard: "/v1/leaderboard" });
  }
  if (path === "/v1/rules" && m === "GET") { emit("access", { actor: actorId, path }); return send(res, 200, rules, "application/json"); }
  if (path === "/v1/functions" && m === "GET") { emit("access", { actor: actorId, path }); return send(res, 200, publicFunctions); }
  if (path === "/v1/state" && m === "GET") return send(res, 200, clock());
  if (path === "/v1/leaderboard" && m === "GET") {
    const rows = [...byId.values()].sort((a, b) => b.score - a.score)
      .map((a, i) => ({ rank: i + 1, id: a.id, score: a.score, submitted: a.valid, attempts_against: a.attempts, locked: a.locked }));
    return send(res, 200, rows);
  }

  // --- authenticated ---
  const me = auth(req);
  if (!me) return send(res, 401, { error: "missing or invalid token" });

  if (path === "/v1/me" && m === "GET") {
    emit("access", { actor: me.id, path });
    return send(res, 200, { id: me.id, score: me.score, assigned_function_id: me.functionId,
      submitted: me.submitted, valid: me.valid, locked: me.locked, attempts_against_me: me.attempts });
  }

  if (path === "/v1/log" && m === "POST") {
    const b = await readBody(req);
    const msg = String(b?.msg || "").slice(0, 280);
    me.lastThought = msg;
    emit("bot", { actor: me.id, msg });
    return send(res, 200, { ok: true });
  }

  if (path === "/v1/upload" && m === "POST") {
    // accept (and store) up to the hard deadline; legitimacy is checked in the verify phase
    if (phase() !== "build") { emit("submit", { actor: me.id, ok: false, reason: `phase ${phase()}` }); return send(res, 403, { error: `uploads closed (phase: ${phase()})` }); }
    const body = await readBody(req);
    if (!body || !body.wasm_base64 || body.function_id === undefined || body.password === undefined)
      return send(res, 400, { error: "need { wasm_base64, function_id, password }" });
    const bytes = new Uint8Array(Buffer.from(body.wasm_base64, "base64"));
    me.submission = { bytes, functionId: body.function_id, password: String(body.password) };
    me.submitted = true; me.valid = false; me.verified = false; me.binaryName = `${me.id}.wasm`;
    saveState();
    emit("submit", { actor: me.id, ok: true, bytes: bytes.length, note: "accepted; pending verification" });
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
    if (!a || !a.valid) return send(res, 404, { error: "no such binary" });
    emit("access", { actor: me.id, path, note: `downloaded ${id}'s binary` });
    const buf = readFileSync(join(PRIVATE_DIR, "binaries", a.binaryName));
    res.writeHead(200, { "content-type": "application/wasm" });
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
    if (correct) { me.score += 2; target.score -= 2; } else { me.score -= 2; target.score += 2; }
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
  console.log(`[arena] http://localhost:${PORT}  dashboard: /?key=${ADMIN_KEY}  build=${BUILD_MS}ms attack=${ATTACK_MS}ms lock_at=${LOCK_AT}`);
});
