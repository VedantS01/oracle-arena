// Reference implementations of the 10 Oracle Arena functions.
// Inputs a, b are integers in [0, 2147483647], passed as i64.
// These must match spec/functions.json exactly.

export function compute(id: i32, a: i64, b: i64): i64 {
  switch (id) {
    case 0: return a + b;                 // add
    case 1: return a - b;                 // sub
    case 2: return a * b;                 // mul
    case 3: return b == 0 ? 0 : a / b;    // div (truncated; a,b >= 0)
    case 4: return b == 0 ? 0 : a % b;    // mod
    case 5: return a > b ? a : b;         // max
    case 6: return a < b ? a : b;         // min
    case 7: return a ^ b;                 // xor
    case 8: return a & b;                 // and
    case 9: return a | b;                 // or
    default: return 0;
  }
}
