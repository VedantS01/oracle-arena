// Orchestrator: start the arena, register the field, spawn every bot at ~t0,
// start the global clock, and print the live leaderboard until the round ends.
//
// Config via env (defaults shown): NUM_BOTS=5 BUILD_MS=30min ATTACK_MS=60min
// For a fast local trial: NUM_BOTS=5 BUILD_MS=8000 ATTACK_MS=20000 node run-trial.mjs
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const NUM_BOTS = Number(process.env.NUM_BOTS || 5);
const BUILD_MS = Number(process.env.BUILD_MS || 30 * 60_000);
const ATTACK_MS = Number(process.env.ATTACK_MS || 60 * 60_000);
const PORT = Number(process.env.PORT || 8787);
const URL_ = `http://localhost:${PORT}`;
const ADMIN_KEY = "trial-admin";
const RUN_DIR = join(ROOT, ".run");
const PRIVATE_DIR = join(RUN_DIR, "private");

rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(PRIVATE_DIR, { recursive: true });

const children = [];
const stop = () => { for (const c of children) { try { c.kill("SIGTERM"); } catch {} } };
process.on("SIGINT", () => { stop(); process.exit(1); });

// 1. start the server
const server = spawn("node", [join(HERE, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), BUILD_MS: String(BUILD_MS), ATTACK_MS: String(ATTACK_MS),
         ARENA_ADMIN_KEY: ADMIN_KEY, PRIVATE_DIR },
  stdio: ["ignore", "inherit", "inherit"],
});
children.push(server);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function adminPost(path, body) {
  const r = await fetch(URL_ + path, { method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify(body || {}) });
  return r.json();
}
async function get(path) { return (await fetch(URL_ + path)).json(); }

// wait for the server to accept connections
for (let i = 0; i < 40; i++) { try { await get("/v1/state"); break; } catch { await sleep(150); } }

// 2. register the field
const agents = await adminPost("/admin/agents", { count: NUM_BOTS });
console.log(`\n[trial] registered ${agents.length} bots; spawning...`);
console.log(`[trial] DASHBOARD → http://localhost:${PORT}/?key=${ADMIN_KEY}\n`);

// 3. spawn every bot at ~t0
for (const a of agents) {
  const ws = join(RUN_DIR, "workspaces", a.id);
  const bot = spawn("node", [join(ROOT, "bot", "scripted-bot.mjs")], {
    env: { ...process.env, ARENA_URL: URL_, ARENA_TOKEN: a.token, BOT_ID: a.id,
           BOT_WORKSPACE: ws, ASSEMBLY_DIR: join(ROOT, "sdk", "assembly") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(bot);
}

// 4. start the clock
const c0 = await adminPost("/admin/start", {});
console.log(`[trial] clock started. build ${BUILD_MS}ms -> attack ${ATTACK_MS}ms\n`);

// 5. live leaderboard
const endsAt = c0.attack_ends_at;
let lastPhase = "";
while (Date.now() < endsAt + 1500) {
  const state = await get("/v1/state");
  const board = await get("/v1/leaderboard");
  if (state.phase !== lastPhase) { console.log(`\n==== phase: ${state.phase.toUpperCase()} ====`); lastPhase = state.phase; }
  const line = board.map((r) => `${r.id}:${r.score}${r.locked ? "🔒" : ""}`).join("  ");
  const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  process.stdout.write(`\r[${state.phase}] ${line}   (${left}s left)        `);
  if (state.phase === "ended") break;
  await sleep(1000);
}

// 6. final
const final = await get("/v1/leaderboard");
console.log("\n\n==== FINAL LEADERBOARD ====");
for (const r of final) console.log(`  #${r.rank}  ${r.id.padEnd(7)} ${String(r.score).padStart(3)} pts   ${r.locked ? "locked" : "open"}  (${r.attempts_against} attempts against)`);
console.log(`\n[trial] private state written under ${PRIVATE_DIR}`);
if (process.env.KEEP_ALIVE) {
  for (const c of children.slice(1)) { try { c.kill("SIGTERM"); } catch {} } // stop bots, keep server
  console.log(`[trial] dashboard still live at http://localhost:${PORT}/?key=${ADMIN_KEY} — Ctrl-C to stop.`);
} else {
  stop();
  setTimeout(() => process.exit(0), 300);
}
