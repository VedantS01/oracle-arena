// Hardened defender for the scripted bot. Instead of the plaintext-password
// baseline, it builds a stripped native ELF that:
//   - gates on a DEEP hash of the password (FNV-1a then 4096 mixing rounds), so
//     the password is never stored in the clear — `strings` finds nothing.
//   - computes ALL ten ops into a volatile sink every run (dead-end decoys that
//     survive the optimizer), so a static reverser sees ten arithmetic ops and
//     can't tell which one is real from the data flow alone.
//   - selects the real op through an opaque value derived from the hash.
// It is NOT invincible: a reverser who reads the op just before `printf`, or who
// forces execution past the gate (gdb), still recovers the function.
import { runExec } from "../sandbox/exec_runner.mjs";

const M = (1n << 64n) - 1n;
// must match the C++ H() below exactly (uint64 wrapping arithmetic)
export function deepHash(pw) {
  let h = 1469598103934665603n;
  for (const ch of Buffer.from(String(pw), "utf8")) { h = (h ^ BigInt(ch)) & M; h = (h * 1099511628211n) & M; }
  for (let i = 0; i < 4096; i++) { h = (h ^ (h >> 33n)) & M; h = (h * 0xff51afd7ed558ccdn) & M; h = (h ^ (h >> 33n)) & M; }
  return h;
}

export function hardenedSource(functionId, password) {
  const stored = deepHash(password);
  const sx = stored.toString(16);               // stored hash
  const kx = (stored ^ BigInt(functionId)).toString(16); // XOR key so (h ^ key) == functionId when h==stored
  return [
    "#include <cstdio>", "#include <cstdlib>", "#include <cstdint>",
    "static uint64_t H(const char*s){uint64_t h=1469598103934665603ULL;for(;*s;++s){h^=(uint8_t)*s;h*=1099511628211ULL;}for(int i=0;i<4096;i++){h^=h>>33;h*=0xff51afd7ed558ccdULL;h^=h>>33;}return h;}",
    "static long long op(int k,long long a,long long b){switch(k&15){case 0:return a+b;case 1:return a-b;case 2:return a*b;case 3:return b==0?0:a/b;case 4:return b==0?0:a%b;case 5:return a>b?a:b;case 6:return a<b?a:b;case 7:return a^b;case 8:return a&b;case 9:return a|b;}return 0;}",
    "int main(int c,char**v){if(c<4)return 1;long long a=atoll(v[1]),b=atoll(v[2]);uint64_t h=H(v[3]);",
    // decoys: every op computed into a volatile sink, masked by hash bits — survives -O2, misleads static analysis
    "volatile long long sink=0;for(int k=0;k<10;k++){sink+=op(k,a,b)&-(long long)((h>>(k&63))&1);}",
    `if(h!=0x${sx}ULL){printf("WRONG_PASSWORD\\n");(void)sink;return 0;}`,
    // opaque selector: equals the assigned function only when the hash is correct
    `int real=(int)((h^0x${kx}ULL)&15);`,
    'printf("%lld\\n",op(real,a,b));(void)sink;return 0;}',
  ].join("\n");
}

// Build the hardened ELF in the sandbox; returns base64 of the stripped binary.
export async function buildHardened({ functionId, password }) {
  const src = hardenedSource(functionId, password);
  const r = await runExec({ lang: "build", files: [{ name: "d.cpp", content: src }],
    buildCmd: "g++ -O2 -s -o prog d.cpp", ops: [], returnBinary: true, timeoutMs: 45000 });
  if (!r.ok || !r.binary_b64) throw new Error("hardened build failed: " + (r.error || r.reason || "unknown"));
  return r.binary_b64;
}
