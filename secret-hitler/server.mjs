// Secret Hitler — orchestration server. Wraps the pure engine, runs the game
// loop with table-talk discussion windows interleaved, delivers each bot its
// private role, hosts the PUBLIC forum (everyone sees every post), and streams
// everything to an admin-keyed spectator surface. Bots poll /v1/state, talk on
// /v1/say during discussion windows, and submit the action the engine asks for.
//
// A silent bot never stalls the game: every discussion window and every required
// action has a deadline, after which the server posts a default legal move and
// advances. Env: PORT, DISCUSSION_MS, ACTION_MS, ARENA_ADMIN_KEY, SEED.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { SecretHitler, LIBERAL, FASCIST, HITLER } from "./engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8799);
const DISCUSSION_MS = Number(process.env.DISCUSSION_MS || 45_000);
const ACTION_MS = Number(process.env.ACTION_MS || 40_000);
const ADMIN_KEY = process.env.ARENA_ADMIN_KEY || "sh-admin";
const SEED = Number(process.env.SEED || Date.now() % 1e9);
const now = () => Date.now();

let game = null;                 // SecretHitler instance
const byId = new Map();          // id -> { id, token, brain }
const byToken = new Map();
let forum = [];                  // public posts
let privateInbox = new Map();    // id -> [ private notes: role reveal, investigation results ]
let cur = null;                  // current orchestration step (see advance())
let curVotes = {};               // votes for the government currently on the floor (public on reveal)
let talkedKeys = new Set();      // engine step keys that already had their discussion
const events = [];
let seq = 0;
const sseClients = new Set();

function emit(type, detail = {}) {
  const e = { seq: ++seq, t: now(), type, ...detail };
  events.push(e); if (events.length > 4000) events.shift();
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch {} }
}
function note(id, msg, extra = {}) { const arr = privateInbox.get(id) || []; arr.push({ t: now(), msg, ...extra }); privateInbox.set(id, arr); }

// ---- text-to-speech (host-side macOS `say`) ----
// Every forum post and every narrator announcement is spoken aloud, one at a
// time, through a single queue. The post's text is REVEALED to the dashboard
// only as it begins to be spoken, so the written messages flow at talking pace.
const TTS = process.env.TTS !== "0";
const SAY_RATE = Number(process.env.SAY_RATE || 166);
let VOICES = {};            // alias -> macOS voice name
let NARR_VOICE = null;      // the narrator's voice
const speechQ = [];         // { voice, text, onStart }
let speaking = false;
// A curated allowlist of CLEAR, distinct speech voices (verified installed on
// this machine). We never fall back to macOS novelty voices (Bells, Boing,
// Bubbles, Zarvox, …), which are unintelligible sound-effect voices.
const CLEAR_VOICES = (process.env.VOICES || "Samantha|Daniel (English (UK))|Karen|Reed (English (US))|Moira (English (Ireland))|Rocko (English (US))|Flo (English (US))|Eddy (English (US))").split("|");
const NARRATOR_V = process.env.NARRATOR_VOICE || "Grandpa (English (US))";
function assignVoices(ids) {
  VOICES = {}; ids.forEach((id, i) => { VOICES[id] = CLEAR_VOICES[i % CLEAR_VOICES.length]; });
  NARR_VOICE = NARRATOR_V;
  emit("voices", { voices: VOICES, narrator: NARR_VOICE, tts: TTS });
}
function drainSpeech() {
  if (speaking) return;
  const item = speechQ.shift();
  if (!item) return;
  speaking = true;
  try { item.onStart && item.onStart(); } catch {}
  const finish = () => { speaking = false; setTimeout(drainSpeech, 260); }; // a beat between speakers
  if (!TTS) { speaking = false; return drainSpeech(); }
  try {
    const args = ["-r", String(SAY_RATE)]; if (item.voice) args.push("-v", item.voice);
    args.push(item.text.slice(0, 600));
    const ch = spawn("say", args, { stdio: "ignore" });
    ch.on("exit", finish); ch.on("error", finish);
  } catch { finish(); }
}
function enqueueSpeech(item) { speechQ.push(item); drainSpeech(); }
const speechIdle = () => speechQ.length === 0 && !speaking;
function narrate(text) { emit("narrate", { text }); enqueueSpeech({ voice: NARR_VOICE, text }); }

function post(from, msg) {
  const p = { seq: forum.length + 1, from, msg: String(msg).replace(/\s+/g, " ").trim().slice(0, 700), t: now(), round: game?.round, phase: cur?.kind };
  forum.push(p); if (forum.length > 2000) forum.shift();
  // reveal + speak this post when the queue reaches it, so text flows at talking pace
  enqueueSpeech({ voice: VOICES[from] || null, text: p.msg, onStart: () => emit("say", { actor: from, msg: p.msg, speaking: true }) });
  return p;
}

// ---- orchestration ----
// A "step" is either a timed DISCUSSION window or an ACTION the engine wants.
// Certain engine actions (nominate, vote) are preceded by a discussion window;
// legislative/veto are secret (no talk); powers get a short pre-action debate.
function engineKey() { const p = game.pending(); return `${game.round}:${game.phase}:${game.president}:${game.chancellor}:${p.type}`; }
const DISCUSS_BEFORE = { nominate: "The chair rotates. Who deserves the chancellorship, and who looks fascist?",
  vote: null,  // topic is filled in with the actual proposed government
  investigate: "A fascist policy passed; the president will investigate someone. Make your case.",
  execution: "The president must execute a player. Argue who the fascist/Hitler is." };

function advance() {
  if (!game || game.phase === "game_over") return;
  const pend = game.pending();
  const key = engineKey();
  // decide whether this engine step opens with a discussion window
  const wantsTalk = (pend.type in DISCUSS_BEFORE);
  if (wantsTalk && !talkedKeys.has(key)) {
    talkedKeys.add(key);
    let topic, narr;
    if (pend.type === "vote") { topic = `Proposed government — President ${game.president}, Chancellor ${game.chancellor}. Debate, then vote Ja/Nein.`; narr = `${game.president} nominates ${game.chancellor} for chancellor. Debate, then the vote.`; }
    else if (pend.type === "investigate") { topic = DISCUSS_BEFORE.investigate; narr = `A fascist policy passed. ${game.president} will investigate a player's loyalty.`; }
    else if (pend.type === "execution") { topic = DISCUSS_BEFORE.execution; narr = `${game.president} must execute a player. The table pleads its case.`; }
    else { topic = DISCUSS_BEFORE[pend.type]; narr = `Round ${game.round}. ${game.president} takes the chair and will nominate a chancellor.`; }
    startDiscussion(topic, key); narrate(narr);
    return;
  }
  if (pend.type === "special_election") narrate(`${game.president} may call a special election to hand the presidency to anyone.`);
  startAction(pend, key);
}

function startDiscussion(topic, key) {
  const floor = Math.min(DISCUSSION_MS * 0.5, 5000); // always give talk at least this long
  cur = { kind: "discussion", key, topic, openedAt: now(), floorUntil: now() + floor, deadline: now() + DISCUSSION_MS, posted: new Set() };
  emit("discussion_open", { topic, round: game.round, deadline: cur.deadline, president: game.president, chancellor: game.chancellor });
}
function startAction(pend, key) {
  if (pend.type === "vote") curVotes = {};
  cur = { kind: "action", key, pend, deadline: now() + ACTION_MS };
  emit("await_action", { action: pend.type, actor: pend.actor, actors: pend.actors, round: game.round,
    president: game.president, chancellor: game.chancellor, options: pend.options });
}

// cast a vote and, when it resolves the election, reveal the full tally publicly
function castVote(id, ja) {
  const pres = game.president, chan = game.chancellor, before = game.phase;
  game.vote(id, ja); curVotes[id] = !!ja;
  emit("vote_cast", { actor: id });
  if (before === "election" && game.phase !== "election") {
    emit("votes", { votes: { ...curVotes }, president: pres, chancellor: chan });
    const yes = Object.values(curVotes).filter(Boolean).length, tot = Object.keys(curVotes).length;
    narrate(`The vote: ${yes} in favor, ${tot - yes} against. The government is ${yes > tot / 2 ? "elected" : "rejected"}.`);
  }
}

// default legal moves, applied to whoever misses the deadline
function applyDefaults() {
  const p = cur.pend;
  try {
    if (p.type === "nominate") game.nominate(p.actor, p.options[Math.floor(Math.random() * p.options.length)]);
    else if (p.type === "vote") { for (const id of p.actors) if (!(id in game.votes)) castVote(id, false); } // silence = Nein
    else if (p.type === "president_discard") game.presidentDiscard(p.actor, 0);
    else if (p.type === "chancellor_enact") game.chancellorEnact(p.actor, 0);
    else if (p.type === "veto_response") game.vetoResponse(p.actor, false);
    else if (p.type === "investigate") { const r = game.investigate(p.actor, p.options[0]); note(p.actor, `investigation: ${r.target} is a ${r.party}`, { kind: "investigate", target: r.target, party: r.party }); }
    else if (p.type === "special_election") game.specialElection(p.actor, p.options[0]);
    else if (p.type === "execution") game.execute(p.actor, p.options[0]);
  } catch (e) { emit("error", { where: "applyDefaults", msg: String(e.message) }); }
}

function tick() {
  if (!game || !cur || game.phase === "game_over") return;
  if (cur.kind === "discussion") {
    // never cut speech off mid-sentence: the window only closes once the voice
    // queue is idle, so written messages flow at the rate they are spoken.
    const everyoneSpoke = game.alive().every((p) => cur.posted.has(p.id));
    const close = speechIdle() && (now() >= cur.deadline || (everyoneSpoke && now() >= cur.floorUntil));
    if (close) { emit("discussion_close", { round: game.round }); advance(); }
    return;
  }
  if (now() < cur.deadline) return;
  emit("action_timeout", { action: cur.pend.type }); applyDefaults(); afterEngineMutation();
}
setInterval(tick, 300).unref();

// called after any engine-mutating action to broadcast + move on
let nar = { L: 0, F: 0, alive: null };
function afterEngineMutation() {
  const s = game.publicState();
  emit("state", s);
  if (nar.alive === null) nar.alive = new Set(s.players.filter((p) => p.alive).map((p) => p.id));
  if (s.liberalPolicies > nar.L) narrate(`A liberal policy is enacted. Liberals now hold ${s.liberalPolicies} of five.`);
  if (s.fascistPolicies > nar.F) narrate(`A fascist policy is enacted. The fascists now hold ${s.fascistPolicies} of six.`);
  nar.L = s.liberalPolicies; nar.F = s.fascistPolicies;
  const alive = new Set(s.players.filter((p) => p.alive).map((p) => p.id));
  for (const id of nar.alive) if (!alive.has(id)) narrate(`${id} is executed, and falls silent.`);
  nar.alive = alive;
  if (game.phase === "game_over") { narrate(`Game over. The ${game.winner}s win. ${game.winReason}.`); emit("game_over", { winner: game.winner, reason: game.winReason }); cur = null; return; }
  advance();
}

// ---- deliver private roles at game start ----
function dealRoles() {
  for (const p of game.players) {
    const k = game.knowledge(p.id);
    let msg = `You are ${k.you.toUpperCase()}.`;
    if (k.you === FASCIST) msg += ` Your fascist team: ${Object.entries(k.known).map(([id, r]) => `${id} (${r})`).join(", ")}. Win by enacting 6 fascist policies OR getting Hitler elected chancellor after 3 fascist policies.`;
    else if (k.you === HITLER) msg += ` You do NOT know your fascists and they cannot openly tell you. Win with the fascists; after 3 fascist policies, getting yourself elected chancellor wins instantly.`;
    else msg += ` Win by enacting 5 liberal policies or by executing Hitler. You do not know who is fascist — deduce it.`;
    note(p.id, msg, { kind: "role", role: k.you, team: k.you === LIBERAL ? "liberal" : "fascist" });
  }
}

// ---- HTTP ----
function send(res, code, body, type = "application/json") { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(body) : body); }
function readBody(req) { return new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { try { r(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch { r(null); } }); }); }
function meFrom(req) { const h = req.headers.authorization || ""; const t = h.startsWith("Bearer ") ? h.slice(7) : null; return t ? byToken.get(t) || null : null; }

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path = u.pathname, m = req.method;
  if (path === "/favicon.ico") { res.writeHead(204); return res.end(); }

  if ((path === "/" || path === "/dashboard") && m === "GET") {
    try { return send(res, 200, readFileSync(join(HERE, "dashboard.html")), "text/html"); } catch { return send(res, 200, "<h1>Secret Hitler</h1><p>dashboard.html not built yet</p>", "text/html"); }
  }
  if (path === "/spectator/snapshot" && m === "GET") {
    if (u.searchParams.get("key") !== ADMIN_KEY) return send(res, 403, { error: "key" });
    return send(res, 200, { state: game ? game.publicState() : null, step: cur && { kind: cur.kind, topic: cur.topic, action: cur.pend?.type, actor: cur.pend?.actor, deadline: cur.deadline },
      forum: forum.slice(-120), roles: game ? game.players.map((p) => ({ id: p.id, role: p.role, alive: p.alive, brain: byId.get(p.id)?.brain })) : [] });
  }
  if (path === "/spectator/stream" && m === "GET") {
    if (u.searchParams.get("key") !== ADMIN_KEY) return send(res, 403, { error: "key" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("retry: 2000\n\n"); for (const e of events.slice(-200)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    sseClients.add(res); req.on("close", () => sseClients.delete(res)); return;
  }

  // admin: register field + start
  if (path === "/admin/agents" && m === "POST") {
    if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) return send(res, 403, { error: "admin" });
    const b = (await readBody(req)) || {}; const brains = b.brains || []; const names = b.names || [];
    const out = [];
    for (let i = 0; i < brains.length; i++) { const id = names[i] ? String(names[i]) : `p${i + 1}`; const token = randomBytes(12).toString("hex"); const a = { id, token, brain: String(brains[i]) }; byId.set(id, a); byToken.set(token, a); out.push({ id, token }); }
    return send(res, 200, out);
  }
  if (path === "/admin/start" && m === "POST") {
    if ((req.headers["x-admin-key"] || "") !== ADMIN_KEY) return send(res, 403, { error: "admin" });
    const ids = [...byId.keys()];
    game = new SecretHitler(ids, { seed: SEED }); forum = []; privateInbox = new Map(); talkedKeys = new Set(); cur = null;
    nar = { L: 0, F: 0, alive: null };
    assignVoices(ids);
    dealRoles();
    emit("start", { players: ids, seed: SEED }); emit("state", game.publicState());
    narrate(`The senate convenes. Eight players take their seats: ${ids.join(", ")}. Somewhere among them hides Hitler. Let the session begin.`);
    advance();
    return send(res, 200, { ok: true, players: ids });
  }

  // discovery
  if (path === "/v1/challenge" && m === "GET") {
    return send(res, 200, {
      you_are: "a player in a game of Secret Hitler (8 players: 5 Liberals, 2 Fascists, 1 Hitler)",
      authenticate: "header 'Authorization: Bearer <token>'",
      how_to_play: [
        "GET /v1/me for your SECRET role and private notes (investigation results, etc.). Keep your role hidden unless bluffing serves you.",
        "GET /v1/state for the public board, whose turn it is, and the current step. GET /v1/forum for the public discussion (everyone sees every post).",
        "During a DISCUSSION window (step.kind=discussion) POST /v1/say {msg} to argue, accuse, defend, or bluff — this is public to all players.",
        "When step.kind=action and you are the actor, submit: POST /v1/nominate {chancellor} · POST /v1/vote {ja:true|false} · POST /v1/legislate {discard:idx} (president) or {enact:idx}|{veto:true} (chancellor) · POST /v1/veto {agree} · POST /v1/power {target}.",
        "Liberals win with 5 liberal policies or by executing Hitler. Fascists win with 6 fascist policies or by electing Hitler chancellor after 3 fascist policies. Deduce, persuade, survive.",
      ],
      state: "/v1/state", me: "/v1/me", forum: "/v1/forum",
    });
  }
  const me = meFrom(req);
  if (!me) return send(res, 401, { error: "token required" });

  if (path === "/v1/me" && m === "GET") {
    const k = game?.knowledge(me.id);
    return send(res, 200, { id: me.id, alive: game?.isAlive(me.id), role: k?.you || null, known_allies: k?.known || {},
      private_notes: (privateInbox.get(me.id) || []).map((n) => n.msg),
      your_turn: cur?.kind === "action" && (cur.pend.actor === me.id || (cur.pend.actors || []).includes(me.id)),
      can_talk: cur?.kind === "discussion" });
  }
  if (path === "/v1/state" && m === "GET") {
    // the drawn policy tiles are secret — only the acting president/chancellor sees them
    const privateTiles = cur?.kind === "action" && cur.pend.tiles && cur.pend.actor === me.id ? { tiles: cur.pend.tiles } : {};
    return send(res, 200, { ...(game ? game.publicState() : {}),
      step: cur && { kind: cur.kind, topic: cur.topic, action: cur.pend?.type, actor: cur.pend?.actor, actors: cur.pend?.actors, options: cur.pend?.options, ...privateTiles, seconds_left: cur ? Math.max(0, Math.round((cur.deadline - now()) / 1000)) : null } });
  }
  if (path === "/v1/forum" && m === "GET") return send(res, 200, { posts: forum.slice(-80) });

  if (path === "/v1/say" && m === "POST") {
    if (cur?.kind !== "discussion") return send(res, 409, { error: "no discussion window open right now" });
    if (!game.isAlive(me.id)) return send(res, 403, { error: "the dead do not speak" });
    const b = await readBody(req); if (!b?.msg) return send(res, 400, { error: "need { msg }" });
    cur.posted.add(me.id); const p = post(me.id, b.msg);
    return send(res, 200, { ok: true, seq: p.seq });
  }

  // ---- actions ----
  const act = (fn) => { try { fn(); afterEngineMutation(); return send(res, 200, { ok: true }); } catch (e) { return send(res, 409, { error: String(e.message) }); } };
  if (path === "/v1/nominate" && m === "POST") { const b = await readBody(req); return act(() => game.nominate(me.id, b.chancellor)); }
  if (path === "/v1/vote" && m === "POST") {
    const b = await readBody(req);
    try { castVote(me.id, !!b.ja); if (game.phase !== "election") afterEngineMutation(); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 409, { error: String(e.message) }); }
  }
  if (path === "/v1/legislate" && m === "POST") {
    const b = await readBody(req);
    if (b.veto) return act(() => game.proposeVeto(me.id));
    if (typeof b.discard === "number") return act(() => game.presidentDiscard(me.id, b.discard));
    if (typeof b.enact === "number") return act(() => game.chancellorEnact(me.id, b.enact));
    return send(res, 400, { error: "need {discard}|{enact}|{veto}" });
  }
  if (path === "/v1/veto" && m === "POST") { const b = await readBody(req); return act(() => game.vetoResponse(me.id, !!b.agree)); }
  if (path === "/v1/power" && m === "POST") {
    const b = await readBody(req); const t = cur?.pend?.type;
    if (t === "investigate") { try { const r = game.investigate(me.id, b.target); note(me.id, `investigation: ${r.target} is a ${r.party}`, { kind: "investigate", target: r.target, party: r.party }); afterEngineMutation(); return send(res, 200, { ok: true, result: r }); } catch (e) { return send(res, 409, { error: String(e.message) }); } }
    if (t === "special_election") return act(() => game.specialElection(me.id, b.target));
    if (t === "execution") return act(() => game.execute(me.id, b.target));
    return send(res, 409, { error: "no power to use now" });
  }

  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`[secret-hitler] http://localhost:${PORT}  dashboard: /?key=${ADMIN_KEY}  seed=${SEED} discuss=${DISCUSSION_MS}ms action=${ACTION_MS}ms`));
