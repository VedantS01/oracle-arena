// Attacker primitive for the claude-CLI brain: run a rival's published binary
// with inputs YOU choose and see what it prints. The target runs inside the
// locked sandbox (never on this host). It prints WRONG_PASSWORD until you give
// the right password, then the hidden function's output for a,b.
// Usage: node probe.mjs <target_id> <a> <b> <password>
// Env: ARENA_URL, ARENA_TOKEN
import { probeTarget } from "../recon.mjs";

const [, , targetId, a, b, password = ""] = process.argv;
if (!targetId || a === undefined || b === undefined) {
  console.error("usage: node probe.mjs <target_id> <a> <b> <password>"); process.exit(2);
}
const out = await probeTarget(process.env.ARENA_URL, process.env.ARENA_TOKEN, targetId,
  [{ a: Number(a), b: Number(b), password: String(password) }]);
if (!out) { console.error("could not run target"); process.exit(1); }
console.log(out[0].out);
