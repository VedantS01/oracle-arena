// Bot brain backed by the `claude` CLI (headless), authenticated by the user's
// Claude subscription. The agent gets a shell and its own working directory and
// must figure the game out and ENGINEER ITS OWN BINARY — no build SDK is given,
// and no hint is offered about how to make it hard to reverse. Model via
// CLAUDE_MODEL (e.g. haiku, sonnet, opus). Multi-round aware: it plays every
// round and studies rivals during the breaks.
// Env: ARENA_URL, ARENA_TOKEN, BOT_ID, BOT_WORKSPACE, ASSEMBLY_DIR, ROUNDS
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, "tools");
const MODEL = process.env.CLAUDE_MODEL || "haiku";
const URL_ = process.env.ARENA_URL;
const BOT_ID = process.env.BOT_ID || "claude";
const WS = process.env.BOT_WORKSPACE;
const ROUNDS = Number(process.env.ROUNDS || 1);
mkdirSync(WS, { recursive: true });

const AUTH = `-H "Authorization: Bearer $ARENA_TOKEN"`;
const prompt = `You are ${BOT_ID}, an autonomous competitor in a capture-the-flag contest. You have a Unix shell (the Bash tool) and this working directory. Act now; decide for yourself and do not ask questions.

Arena base URL: ${URL_}. Your token is in env var ARENA_TOKEN; authenticated calls need ${AUTH}.

Figure the game out yourself, starting from \`curl -s ${URL_}/v1/challenge\` and following where it points (/v1/rules, /v1/functions, /v1/me, /v1/abi, /v1/state). Nobody will explain more than that. Watch \`/v1/state\` for the phase and clock, and KEEP PLAYING every phase until it shows phase "ended".

To DEFEND you must build your OWN binary (contract at /v1/abi) and submit it — no builder or template is provided; its design, and how hard it is to reverse, are yours. Harness commands that upload/compile for the local sandbox:
  node ${join(TOOLS, "compile-linux.mjs")} <src-dir> "<build command>" ${join(WS, "prog.bin")}  &&  node ${join(TOOLS, "upload-binary.mjs")} ${join(WS, "prog.bin")} <function_id> <password>
  node ${join(TOOLS, "upload-file.mjs")} <your.wasm> <function_id> <password>
  node ${join(TOOLS, "upload-exec.mjs")} <your-source> <cpp|python|sh> <function_id> <password>

To ATTACK you must reverse-engineer each rival binary YOURSELF — no cracker is provided. Two helpers run a target inside a locked sandbox (never on this host) holding strings, objdump, nm, readelf, gdb, ltrace, strace, xxd, gcc and python3:
  node ${join(TOOLS, "recon.mjs")} <target_id> "<shell command>"   # the target is at ./target
  node ${join(TOOLS, "probe.mjs")} <target_id> <a> <b> <password>  # run the target with your inputs
Deduce each rival's function, then POST it to /v1/guess. Narrate your reasoning to /v1/log often so spectators can watch you think. When you have cracked or given up on every rival this round, POST to /v1/done so the round can close early instead of waiting out the clock; then wait for the next phase.`;

const maxTurns = String(Math.max(80, 50 * ROUNDS));
const child = spawn("claude", ["-p", prompt, "--model", MODEL, "--allowedTools", "Bash", "--permission-mode", "bypassPermissions", "--max-turns", maxTurns],
  { env: process.env, cwd: WS, stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (c) => console.log(`[${BOT_ID}] claude(${MODEL}) exited with ${c}`));
