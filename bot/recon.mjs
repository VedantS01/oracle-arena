// Raw attacker primitives. Unlike crack.mjs (the scripted reference bot's canned
// auto-cracker), these do NOT recover passwords or identify functions for you.
// They give you two powers and nothing more:
//   probeTarget  run a rival's published artifact with inputs YOU choose and see
//                what it prints (WRONG_PASSWORD until you find its password).
//   reconTarget  run ONE shell command against the downloaded artifact inside the
//                locked sandbox, which holds strings/objdump/nm/readelf/gdb/
//                ltrace/strace/xxd/gcc/python3. The target is at ./target.
// Recovering the password and deducing the function from what you observe is the
// contest — that reasoning is yours to do, by whatever method you invent.
import { runExec } from "../sandbox/exec_runner.mjs";

const WRONG_I64 = -(2n ** 63n);
const isWasm = (b) => b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
const isElf = (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;

async function fetchArtifact(arenaUrl, token, id) {
  const r = await fetch(`${arenaUrl}/v1/binary/${id}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return { kind: r.headers.get("x-artifact-kind") || "", bytes: new Uint8Array(await r.arrayBuffer()) };
}

// Run a WASM target per the published ABI (memory + pwd_ptr() + run(a,b,len)).
function probeWasm(bytes, cases) {
  let ex; try { ex = (new WebAssembly.Instance(new WebAssembly.Module(bytes), {})).exports; } catch { return null; }
  const { memory, pwd_ptr, run } = ex;
  if (typeof run !== "function" || typeof pwd_ptr !== "function") return null;
  const call = (pw, a, b) => { const p = new TextEncoder().encode(pw); new Uint8Array(memory.buffer, Number(pwd_ptr()), p.length).set(p); return run(BigInt(a), BigInt(b), p.length); };
  return cases.map((c) => {
    let v; try { v = call(String(c.password ?? c.pw ?? ""), c.a, c.b); } catch { return { ...c, out: "<err>" }; }
    return { ...c, out: v === WRONG_I64 ? "WRONG_PASSWORD" : v.toString() };
  });
}

// Run `target a b password` for each case; returns [{a,b,password,out}, ...].
export async function probeTarget(arenaUrl, token, id, cases) {
  const art = await fetchArtifact(arenaUrl, token, id);
  if (!art || !cases?.length) return null;
  const { kind, bytes } = art;
  if (kind === "wasm" || isWasm(bytes)) return probeWasm(bytes, cases);
  const ops = cases.map((c) => [String(c.a), String(c.b), String(c.password ?? c.pw ?? "")]);
  const lang = kind === "python" || kind === "sh" ? kind : "binary";
  const r = await runExec({ lang, sourceBytes: bytes, ops, timeoutMs: 40000 });
  if (!r.ok) return null;
  return cases.map((c, i) => ({ ...c, out: String(r.results[i]) }));
}

// Run ONE shell command against the downloaded target inside the sandbox. The
// target is at ./target; `files` are extra helper files written alongside it.
// Returns { ok, rc, stdout, stderr }. For a WASM target the bytes are at ./target
// too (inspect with xxd / wasm tooling you bring).
export async function reconTarget(arenaUrl, token, id, cmd, files) {
  const art = await fetchArtifact(arenaUrl, token, id);
  if (!art) return null;
  return runExec({ lang: "recon", sourceBytes: art.bytes, cmd, files, cmdTimeout: 15, timeoutMs: 60000 });
}

export { fetchArtifact, isWasm, isElf };
