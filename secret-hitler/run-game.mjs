// Orchestrator: start the Secret Hitler server, register the 8-model field,
// spawn a claude-backed player per model, start the game, and print the live
// public log (board + forum) until a side wins. Set KEEP_ALIVE=1 to leave the
// dashboard server up afterwards.
//
// Field via BRAINS (comma list of claude models). Default is the full cast.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = Number(process.env.PORT || 8799);
const URL_ = `http://localhost:${PORT}`;
const ADMIN = "sh-admin";
const RUN_DIR = join(ROOT, ".sh-run");
const BRAINS = (process.env.BRAINS || "haiku,haiku,sonnet,sonnet,opus,claude-fable-5-1,claude-opus-5-5,claude-opus-4-8")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (BRAINS.length !== 8) { console.error(`need exactly 8 brains, got ${BRAINS.length}`); process.exit(1); }
// themed animal codenames — the players' public identities (bots address each other by these)
const ALIASES = ["Falcon", "Nightingale", "Fox", "Owl", "Wolf", "Serpent", "Bear", "Stag"];

rmSync(RUN_DIR, { recursive: true, force: true }); mkdirSync(RUN_DIR, { recursive: true });
const children = [];
const stop = () => { for (const c of children) { try { c.kill("SIGTERM"); } catch {} } };
process.on("SIGINT", () => { stop(); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adminPost = (p) => fetch(URL_ + p, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN }, body: "{}" }).then((r) => r.json());
const agentsPost = (brains, names) => fetch(URL_ + "/admin/agents", { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN }, body: JSON.stringify({ brains, names }) }).then((r) => r.json());
const snap = () => fetch(`${URL_}/spectator/snapshot?key=${ADMIN}`).then((r) => r.json());

// 1. server
const server = spawn("node", [join(HERE, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), ARENA_ADMIN_KEY: ADMIN,
    DISCUSSION_MS: String(process.env.DISCUSSION_MS || 45000), ACTION_MS: String(process.env.ACTION_MS || 40000) },
  stdio: ["ignore", "inherit", "inherit"] });
children.push(server);
for (let i = 0; i < 40; i++) { try { await fetch(URL_ + "/v1/challenge"); break; } catch { await sleep(150); } }

// 2. register the field
const reg = await agentsPost(BRAINS, ALIASES);
console.log(`\n[sh] registered ${reg.length} players; dashboard → ${URL_}/?key=${ADMIN}\n`);

// 3. spawn one claude player per brain
// Run bots at LOWEST CPU priority (nice 19) so the server's realtime `say`
// audio is never starved during the bots' "thinking" CPU bursts (which was
// making speech stutter under the 8-process load).
reg.forEach((a, i) => {
  const bot = spawn("nice", ["-n", "19", "node", join(ROOT, "bot", "sh-bot.mjs")], {
    env: { ...process.env, ARENA_URL: URL_, ARENA_TOKEN: a.token, BOT_ID: a.id, CLAUDE_MODEL: BRAINS[i], BOT_WORKSPACE: join(RUN_DIR, a.id) },
    stdio: ["ignore", "inherit", "inherit"] });
  children.push(bot);
  console.log(`[sh]   ${a.id}: ${BRAINS[i]}`);
});

// 4. start
await adminPost("/admin/start");
console.log(`\n[sh] game started (seed-random). secret roles dealt privately.\n`);
const modelOf = Object.fromEntries(reg.map((a, i) => [a.id, BRAINS[i]]));

// 5. live public log until someone wins
let printedForum = 0, lastBoard = "";
for (;;) {
  let s; try { s = await snap(); } catch { await sleep(1000); continue; }
  const st = s.state || {};
  for (const p of s.forum.slice(printedForum)) console.log(`   💬 ${p.from}: ${p.msg}`);
  printedForum = s.forum.length;
  const board = `${st.liberalPolicies||0}L/${st.fascistPolicies||0}F tracker=${st.electionTracker||0} pres=${st.president} chan=${st.chancellor||"-"} [${s.step?.kind||"?"}${s.step?.action?":"+s.step.action:""}]`;
  if (board !== lastBoard) { console.log(`— r${st.round} · ${board}`); lastBoard = board; }
  if (st.winner) {
    console.log(`\n==== GAME OVER — ${String(st.winner).toUpperCase()} WIN ====\n${st.winReason}`);
    console.log("roles:", s.roles.map((r) => `${r.id}(${modelOf[r.id]})=${r.role}${r.alive ? "" : "†"}`).join("  "));
    break;
  }
  await sleep(1500);
}

if (process.env.KEEP_ALIVE) { for (const c of children.slice(1)) { try { c.kill("SIGTERM"); } catch {} } console.log(`\n[sh] dashboard still live at ${URL_}/?key=${ADMIN} — Ctrl-C to stop.`); }
else { stop(); setTimeout(() => process.exit(0), 300); }
