// Reference implementations of the 10 Oracle Arena functions, in BigInt.
// Authoritative alongside spec/functions.json and the SDK's AssemblyScript.
// Used by the validator (honesty check) and, later, the arena (adjudication).
// Inputs a, b are BigInt in [0, 2147483647]; results are exact (fit in i64).

export const P = 2147483647n;

export function fref(id, a, b) {
  switch (id) {
    case 0: return a + b;                     // add
    case 1: return a * b;                     // mul
    case 2: return gcd(a, b);                 // gcd
    case 3: return a > b ? a : b;             // max
    case 4: return a ^ b;                     // xor
    case 5: return a % (b + 1n);              // mod1
    case 6: return popcount(a) + popcount(b); // popcount2
    case 7: return (a * b) % P;               // mulmod_p
    case 8: return a > b ? a - b : b - a;     // absdiff
    case 9: return a * a + b * b;             // sumsq
    default: throw new Error("bad function id: " + id);
  }
}

function gcd(a, b) {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function popcount(x) {
  let c = 0n;
  while (x > 0n) { c += x & 1n; x >>= 1n; }
  return c;
}
