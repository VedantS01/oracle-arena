// Attacker primitive for the claude-CLI brain: download a rival's binary and run
// ONE shell command against it inside the locked sandbox (the target is at
// ./target). The sandbox holds strings, objdump, nm, readelf, gdb,
// ltrace, strace, xxd, gcc, g++, python3. What you do with them is yours to
// invent; the raw stdout/stderr come back for you to reason over.
// Usage: node recon.mjs <target_id> "<shell command>"
// Env: ARENA_URL, ARENA_TOKEN
import { reconTarget } from "../recon.mjs";

const [, , targetId, ...rest] = process.argv;
const cmd = rest.join(" ");
if (!targetId || !cmd) { console.error('usage: node recon.mjs <target_id> "<shell command>"'); process.exit(2); }

const r = await reconTarget(process.env.ARENA_URL, process.env.ARENA_TOKEN, targetId, cmd);
if (!r) { console.error("could not run recon"); process.exit(1); }
if (!r.ok) { console.error(r.error || "recon failed"); process.exit(1); }
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.rc === 0 ? 0 : 0); // RE commands often exit non-zero; output is what matters
