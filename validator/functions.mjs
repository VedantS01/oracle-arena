// Reference implementations of the 10 Oracle Arena functions, in BigInt.
// Authoritative alongside spec/functions.json and the SDK's AssemblyScript.
// Used by the validator (honesty check) and the arena (guess adjudication).
// Inputs a, b are BigInt in [0, 2147483647]; results fit in i64.

export function fref(id, a, b) {
  switch (id) {
    case 0: return a + b;                   // add
    case 1: return a - b;                   // sub
    case 2: return a * b;                   // mul
    case 3: return b === 0n ? 0n : a / b;   // div (BigInt truncates toward zero; a,b >= 0)
    case 4: return b === 0n ? 0n : a % b;   // mod
    case 5: return a > b ? a : b;           // max
    case 6: return a < b ? a : b;           // min
    case 7: return a ^ b;                   // xor
    case 8: return a & b;                   // and
    case 9: return a | b;                   // or
    default: throw new Error("bad function id: " + id);
  }
}
