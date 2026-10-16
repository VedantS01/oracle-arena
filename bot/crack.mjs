// Unified attacker toolkit: download a target's published artifact and try to
// recover its password and identify its function. WASM is cracked in-process;
// a native ELF or a script is cracked by running candidate passwords and probe
// inputs inside the SAME locked sandbox used for verification (so an attacker
// never runs an untrusted target on the host either).
import { runExec } from "../sandbox/exec_runner.mjs";
import { fref } from "../validator/functions.mjs";

const WRONG_I64 = -(2n ** 63n);
const PROBES = [[6n, 10n], [12n, 10n], [9n, 5n], [8n, 3n], [14n, 6n], [13n, 13n]];

export function extractStrings(bytes, min = 4, cap = 400) {
  const out = []; const seen = new Set(); let cur = "";
  const push = (s) => { if (s.length >= min && !seen.has(s)) { seen.add(s); out.push(s); } };
  for (const b of bytes) { if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b); else { push(cur); cur = ""; } }
  push(cur);
  return out.slice(0, cap);
}

function finalize(password, samples) {
  let cands = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (const s of samples) {
    const a = BigInt(s.a), b = BigInt(s.b);
    cands = cands.filter((id) => { try { return String(fref(id, a, b)) === s.out; } catch { return false; } });
    if (cands.length <= 1) break;
  }
  return { cracked: true, password, samples, functionId: cands.length === 1 ? cands[0] : null };
}

async function crackWasm(bytes) {
  let ex; try { ex = (await WebAssembly.instantiate(bytes, {})).instance.exports; } catch { return null; }
  const { memory, pwd_ptr, run } = ex;
  if (typeof run !== "function" || typeof pwd_ptr !== "function") return null;
  const call = (pw, a, b) => { const p = new TextEncoder().encode(pw); new Uint8Array(memory.buffer, Number(pwd_ptr()), p.length).set(p); return run(a, b, p.length); };
  let pw = null;
  for (const c of extractStrings(bytes, 3)) { try { if (call(c, 13n, 7n) !== WRONG_I64) { pw = c; break; } } catch {} }
  if (pw === null) return null;
  return finalize(pw, PROBES.map(([a, b]) => ({ a: a.toString(), b: b.toString(), out: call(pw, a, b).toString() })));
}

async function crackSandbox(payload, bytes) {
  const cands = extractStrings(bytes, 4);
  if (!cands.length) return null;
  const r1 = await runExec({ ...payload, ops: cands.map((c) => [13, 7, c]), timeoutMs: 40000 });
  if (!r1.ok) return null;
  let pw = null;
  for (let i = 0; i < cands.length; i++) { const o = r1.results[i]; if (o && o !== "WRONG_PASSWORD" && /^-?\d+$/.test(o)) { pw = cands[i]; break; } }
  if (pw === null) return null;
  const r2 = await runExec({ ...payload, ops: PROBES.map(([a, b]) => [Number(a), Number(b), pw]), timeoutMs: 40000 });
  if (!r2.ok) return null;
  return finalize(pw, PROBES.map(([a, b], k) => ({ a: a.toString(), b: b.toString(), out: String(r2.results[k]) })));
}

// Download a target's artifact and crack it, dispatching on the published kind.
// Returns { cracked, password, samples, functionId } or null.
export async function fetchAndCrack(arenaUrl, token, id) {
  const r = await fetch(`${arenaUrl}/v1/binary/${id}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const kind = r.headers.get("x-artifact-kind") || "";
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (kind === "wasm" || (bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) return crackWasm(bytes);
  if (kind === "elf" || (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)) return crackSandbox({ lang: "binary", sourceBytes: bytes }, bytes);
  if (kind === "python" || kind === "sh") return crackSandbox({ lang: kind, source: Buffer.from(bytes).toString("utf8") }, bytes);
  return null;
}
