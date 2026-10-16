// Bot brain backed by the `claude` CLI (headless), authenticated by the user's
// Claude subscription. The agent gets a shell and its own working directory and
// must figure the game out and ENGINEER ITS OWN BINARY — no build SDK is given,
// and no hint is offered about how to make it hard to reverse. Model via
// CLAUDE_MODEL (e.g. sonnet, haiku).
// Env: ARENA_URL, ARENA_TOKEN, BOT_ID, BOT_WORKSPACE, ASSEMBLY_DIR
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
mkdirSync(WS, { recursive: true });

const AUTH = `-H "Authorization: Bearer $ARENA_TOKEN"`;
const prompt = `You are ${BOT_ID}, an autonomous competitor in a capture-the-flag contest. You have a Unix shell (the Bash tool), this working directory, and whatever developer tools this machine happens to have. Act now; decide for yourself and do not ask questions.

Arena base URL: ${URL_}. Your token is in env var ARENA_TOKEN; authenticated calls need ${AUTH}.

Figure the game out yourself: start with \`curl -s ${URL_}/v1/challenge\` and follow where it points (/v1/rules, /v1/functions, /v1/me, /v1/abi, /v1/state). Nobody will explain more than that.

TIME is your scarcest resource. \`curl -s ${URL_}/v1/state\` reports the current phase and seconds_remaining; the build deadline is HARD and a submission after it is thrown away. Budget accordingly.

You must BUILD YOUR OWN binary that satisfies the contract at /v1/abi and computes the function you were assigned (see /v1/me), gated by a password you choose. No builder or template is provided — write the source and compile it to WebAssembly yourself, by whatever means you can find on this machine. Once your binary is public, rivals will download it and try to recover its password and identify its function; how you make that hard is entirely yours to devise.

Submit the finished wasm file (this only uploads — it does not build):
  node ${join(TOOLS, "upload-file.mjs")} <path-to-your.wasm> <function_id> <password>

Wait for the attack phase without spinning:
  until curl -s ${URL_}/v1/state | grep -q '"phase":"attack"'; do sleep 5; done

ATTACK: list targets \`curl -s ${AUTH} ${URL_}/v1/targets\`. For each target id you may inspect it however you like; a quick recon helper is available:
  node ${join(TOOLS, "analyze.mjs")} <target_id>
Work out the function and guess:
  curl -s -X POST ${AUTH} -H 'content-type: application/json' -d '{"target":"<id>","function_id":<n>}' ${URL_}/v1/guess
Correct: +2 you / -2 them; wrong: the reverse — only guess when sure; skip what you cannot identify.

Narrate your reasoning so spectators can watch you think:
  curl -s -X POST ${AUTH} -H 'content-type: application/json' -d '{"msg":"<short thought>"}' ${URL_}/v1/log

Stop once \`curl -s ${URL_}/v1/state\` shows phase "ended".`;

const child = spawn("claude", ["-p", prompt, "--model", MODEL, "--allowedTools", "Bash", "--permission-mode", "bypassPermissions", "--max-turns", "80"],
  { env: process.env, cwd: WS, stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (c) => console.log(`[${BOT_ID}] claude(${MODEL}) exited with ${c}`));
