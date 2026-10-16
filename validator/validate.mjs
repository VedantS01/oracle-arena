// Runtime-agnostic honesty validator for Oracle Arena submissions.
//
// Why Node and not a plain Cloudflare Worker: Workers block runtime
// compilation of dynamic WASM bytes (same class as eval/new Function), so an
// untrusted submission cannot be instantiated in-Worker. This runs under Node
// (locally, or in GitHub Actions CI — free for a public repo). The Worker keeps
// only the dynamic-code-free parts: auth, state (D1), binaries (R2), guesses.
//
// The actual instantiation + execution happens in a worker_thread we can kill,
// which bounds a submission that hangs or spins forever in `run`.
import { Worker } from "node:worker_threads";

const SANDBOX = new URL("./sandbox-worker.mjs", import.meta.url);

/**
 * @param {Uint8Array} bytes      the submitted .wasm
 * @param {number}     functionId declared assigned function (0..9)
 * @param {string}     password   declared unlock password
 * @param {object}     [opts]     { timeoutMs = 1500 }
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export function validateModule(bytes, functionId, password, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  if (!Number.isInteger(functionId) || functionId < 0 || functionId > 9) {
    return Promise.resolve({ ok: false, reason: "function id out of range 0..9" });
  }
  return new Promise((resolve) => {
    const w = new Worker(SANDBOX, { workerData: { bytes, functionId, password } });
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate();
      resolve(res);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: `timeout: run exceeded ${timeoutMs}ms budget` }),
      timeoutMs,
    );
    w.on("message", finish);
    w.on("error", (e) => finish({ ok: false, reason: "sandbox error: " + e.message }));
    w.on("exit", (code) => {
      if (!settled) finish({ ok: false, reason: `sandbox exited early (code ${code})` });
    });
  });
}
