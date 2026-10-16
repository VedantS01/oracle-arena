// Reference implementations of the 10 Oracle Arena functions.
// Inputs a, b are integers in [0, 2147483647], passed as i64.
// These must match spec/functions.json exactly.

export function compute(id: i32, a: i64, b: i64): i64 {
  switch (id) {
    case 0: return a + b;                        // add
    case 1: return a * b;                        // mul
    case 2: return gcd(a, b);                    // gcd
    case 3: return a > b ? a : b;                // max
    case 4: return a ^ b;                        // xor
    case 5: return a % (b + 1);                  // mod1  (b+1 avoids div-by-zero)
    case 6: return popcnt<i64>(a) + popcnt<i64>(b); // popcount2
    case 7: return (a * b) % 2147483647;         // mulmod_p (a*b < 2^62, no overflow)
    case 8: return a > b ? a - b : b - a;        // absdiff
    case 9: return a * a + b * b;                // sumsq
    default: return 0;
  }
}

function gcd(a: i64, b: i64): i64 {
  while (b != 0) {
    let t = b;
    b = a % b;
    a = t;
  }
  return a;
}
