// Host side: run an untrusted participant program in a locked-down container.
// Nothing from the host is mounted; the job (source + ops) goes in over stdin
// and results come back over stdout. The container has no network, a read-only
// rootfs, a writable tmpfs /work only, all caps dropped, a non-root user, and
// cpu/memory/pids caps; a wall-clock timeout kills it.
import { spawn } from "node:child_process";

const IMAGE = process.env.SANDBOX_IMAGE || "oracle-sandbox";
const LOCKDOWN = [
  "run", "--rm", "-i",
  "--network=none",
  "--read-only",
  "--tmpfs", "/work:rw,exec,size=64m,mode=1777",
  "--memory=256m", "--memory-swap=256m",
  "--cpus=1", "--pids-limit=128",
  "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "-u", "65534:65534", "-e", "TMPDIR=/work", "-w", "/work",
];

/**
 * @param {{lang:string, source:string, ops:Array<[number|string,number|string,string]>, timeoutMs?:number}} job
 * @returns {Promise<{ok:boolean, results?:string[], stage?:string, error?:string, reason?:string}>}
 */
export function runExec({ lang, source, ops, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const p = spawn("docker", [...LOCKDOWN, IMAGE], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (o) => { if (done) return; done = true; clearTimeout(timer); try { p.kill("SIGKILL"); } catch {} resolve(o); };
    const timer = setTimeout(() => finish({ ok: false, reason: `sandbox timeout (${timeoutMs}ms)` }), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => finish({ ok: false, reason: "docker spawn failed: " + e.message }));
    p.on("close", () => {
      if (done) return;
      done = true; clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop();
      try { resolve(JSON.parse(line)); }
      catch { resolve({ ok: false, reason: "unreadable sandbox output: " + (err || out).slice(0, 200) }); }
    });
    const payload = { lang, source_b64: Buffer.from(source, "utf8").toString("base64"), ops, op_timeout: 2, compile_timeout: 15 };
    p.stdin.write(JSON.stringify(payload));
    p.stdin.end();
  });
}
