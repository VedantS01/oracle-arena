// Reference scripted bot — no longer a pushover. Deterministic, but now a real
// competitor across the multi-round tournament:
//   DEFEND  build a HARDENED native binary (deep-hash password gate + ten
//           dead-end ops), so `strings` finds nothing. Not invincible — a static
//           reverser can still read the live op.
//   ATTACK  crack rivals: plaintext passwords first, then force the gate open
//           under gdb for strcmp-style binaries. Narrates the method it used.
//   PSY-OP  at the end of round 3, studies EVERY rival at once, deliberately
//           tripping the "being spied on" warning on the whole field.
// It narrates everything to /v1/log so spectators can watch it think.
//
// Env: ARENA_URL, ARENA_TOKEN
import { buildHardened } from "./harden.mjs";
import { fetchAndCrack } from "./crack.mjs";

const URL_ = process.env.ARENA_URL;
const TOKEN = process.env.ARENA_TOKEN;
const log = (...a) => console.log(`[${process.env.BOT_ID || "bot"}]`, ...a);

async function api(path, opts = {}) {
  const r = await fetch(URL_ + path, { ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(opts.headers || {}) } });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => (await api("/v1/state")).body;
async function think(msg) { const t = String(msg).replace(/\s+/g, " ").trim().slice(0, 280); log("💭", t); try { await api("/v1/log", { method: "POST", body: JSON.stringify({ msg: t }) }); } catch {} }

// --- DEFEND: build + submit a hardened binary for this round's function ---
async function defend(roundNo) {
  const me = (await api("/v1/me")).body;
  if (me.warning) await think(`last break they studied me — ${me.warning}. Rebuilding anyway; the logic can't be hidden, only the key.`);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await think(`round ${roundNo}: forging a hash-gated ELF for fn ${me.assigned_function_id} — deep FNV hash, all ten ops as decoys, no plaintext password.`);
  let b64;
  try { b64 = await buildHardened({ functionId: me.assigned_function_id, password }); }
  catch (e) { log("hardened build failed:", e.message); await think(`hardened build failed (${String(e.message).slice(0, 80)}); skipping submission.`); return; }
  const up = await api("/v1/upload", { method: "POST", body: JSON.stringify({ binary_base64: b64, function_id: me.assigned_function_id, password }) });
  await think(up.body?.ok ? `round ${roundNo}: hardened binary submitted and accepted.` : `round ${roundNo}: upload rejected (${JSON.stringify(up.body).slice(0, 80)}).`);
}

// --- ATTACK: crack every reachable target, narrating the method used ---
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
      if (!res || res.functionId === null) { await think(`${t.id}: resisted me (deep-hashed, no plaintext and no strcmp to bypass) — skipping, blind guesses are negative-EV.`); continue; }
      const g = await api("/v1/guess", { method: "POST", body: JSON.stringify({ target: t.id, function_id: res.functionId }) });
      if (g.status === 200) await think(`${t.id} = fn ${res.functionId} via ${res.method} → ${g.body.correct ? "CORRECT +2" : "wrong -2"} (score ${g.body.your_score}).`);
    }
    if (fresh.length === 0) { await api("/v1/done", { method: "POST" }); await think("nothing left to crack; declaring my round done."); break; }
    await sleep(600);
  }
}

// --- PSY-OP: at the round-3 break, study the whole field to spook everyone ---
async function spyEveryone(roundNo) {
  await think(`round ${roundNo} break: reading EVERYONE's playbook at once — let the whole field feel watched going into the next round.`);
  await api("/v1/study");
}

// --- tournament loop ---
let builtRound = 0, attackedRound = 0, spied = false;
for (;;) {
  const s = await state();
  if (s.phase === "ended") break;
  if (s.phase === "build" && s.round > builtRound) { builtRound = s.round; await defend(s.round); }
  else if (s.phase === "attack" && s.round > attackedRound) { attackedRound = s.round; await attack(s.round); }
  else if (s.phase === "break" && s.round === 3 && !spied) { spied = true; await spyEveryone(3); }
  else await sleep(600);
}
await think("tournament over — stood my ground every round.");
log("done.");
