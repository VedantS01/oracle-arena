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
export function runExec({ lang, source, sourceBytes, files, buildCmd, cmd, cmdTimeout = 15, ops, timeoutMs = 20000, returnBinary = false }) {
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
    let payload;
    if (lang === "build") {
      payload = { lang: "build", build_cmd: buildCmd || "", ops, op_timeout: 2, compile_timeout: 30, return_binary: returnBinary,
        files: (files || []).map((f) => ({ name: f.name, content_b64: Buffer.from(f.content, "utf8").toString("base64") })) };
    } else if (lang === "recon") {
      // free-form RE: the target goes in as source_b64 (written to ./target), the
      // attacker's shell command runs against it, raw stdout/stderr come back.
      const target_b64 = sourceBytes ? Buffer.from(sourceBytes).toString("base64") : Buffer.from(source || "", "utf8").toString("base64");
      payload = { lang: "recon", source_b64: target_b64, cmd: cmd || "", cmd_timeout: cmdTimeout,
        files: (files || []).map((f) => ({ name: f.name, content_b64: Buffer.from(f.content, "utf8").toString("base64") })) };
    } else {
      const source_b64 = sourceBytes ? Buffer.from(sourceBytes).toString("base64") : Buffer.from(source || "", "utf8").toString("base64");
      payload = { lang, source_b64, ops, op_timeout: 2, compile_timeout: 15, return_binary: returnBinary };
    }
    p.stdin.write(JSON.stringify(payload));
    p.stdin.end();
  });
}
