// Helper CLI for the claude-CLI brain: download a rival binary and try to crack
// it, printing the recovered password and sample input/output pairs so the agent
// can deduce the function. Usage: node analyze.mjs <target_id>
// Env: ARENA_URL, ARENA_TOKEN
const WRONG = -(2n ** 63n);
const [, , targetId] = process.argv;
if (!targetId) { console.error("usage: node analyze.mjs <target_id>"); process.exit(2); }

const r = await fetch(`${process.env.ARENA_URL}/v1/binary/${targetId}`, { headers: { authorization: `Bearer ${process.env.ARENA_TOKEN}` } });
if (!r.ok) { console.log(JSON.stringify({ cracked: false, status: r.status })); process.exit(0); }
const bytes = new Uint8Array(await r.arrayBuffer());

function extractStrings(b, min = 3) {
  const out = new Set(); let cur = "";
  for (const c of b) { if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c); else { if (cur.length >= min) out.add(cur); cur = ""; } }
  if (cur.length >= min) out.add(cur);
  for (const s of [...out]) for (let i = 0; i < s.length; i++) for (let j = i + min; j <= s.length; j++) out.add(s.slice(i, j));
  return [...out];
}

let ex; try { ex = (await WebAssembly.instantiate(bytes, {})).instance.exports; } catch { console.log(JSON.stringify({ cracked: false, note: "not instantiable" })); process.exit(0); }
const { memory, pwd_ptr, run } = ex;
const call = (pw, a, b) => { const p = new TextEncoder().encode(pw); new Uint8Array(memory.buffer, Number(pwd_ptr()), p.length).set(p); return run(a, b, p.length); };
let pw = null;
for (const cand of extractStrings(bytes)) { try { if (call(cand, 13n, 7n) !== WRONG) { pw = cand; break; } } catch {} }
if (pw === null) { console.log(JSON.stringify({ cracked: false, note: "password not recovered" })); process.exit(0); }
const probes = [[6n, 10n], [12n, 10n], [9n, 5n], [8n, 3n], [14n, 6n], [13n, 13n]];
const samples = probes.map(([a, b]) => ({ a: a.toString(), b: b.toString(), out: call(pw, a, b).toString() }));
console.log(JSON.stringify({ cracked: true, password: pw, samples }));
