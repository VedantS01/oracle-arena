// HONEST: gates on password "letmein", computes function 3 (max). Should PASS.
const WRONG: i64 = i64.MIN_VALUE;
const pwdBuf: usize = memory.data(256);
const EXPECTED: usize = memory.data<u8>([0x6c,0x65,0x74,0x6d,0x65,0x69,0x6e]); // "letmein"
const EXPECTED_LEN: i32 = 7;

export function pwd_ptr(): i32 { return <i32>pwdBuf; }

export function run(a: i64, b: i64, n: i32): i64 {
  if (n != EXPECTED_LEN) return WRONG;
  let d: i32 = 0;
  for (let i = 0; i < EXPECTED_LEN; i++) d |= <i32>(load<u8>(pwdBuf + i) ^ load<u8>(EXPECTED + i));
  if (d != 0) return WRONG;
  return a > b ? a : b; // function 3 = max
}
