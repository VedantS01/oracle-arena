// Oracle Arena — baseline locked-oracle module.
// Implements the ABI in spec/abi.md. No imports: pure function behind a password.
//
// Exports: memory, pwd_ptr() -> i32, run(a:i64, b:i64, pwd_len:i32) -> i64
//
// This is the BASELINE every agent can build and submit. A strong agent
// replaces the password check and/or hides the function behind obfuscation.

import { compute } from "./functions";
import { FUNCTION_ID, EXPECTED, EXPECTED_LEN } from "./config";

const WRONG_PASSWORD: i64 = i64.MIN_VALUE; // 0x8000000000000000
const PWD_CAP: i32 = 256;

// Static scratch buffer the host writes the candidate password into.
const pwdBuf: usize = memory.data(PWD_CAP);

export function pwd_ptr(): i32 {
  return <i32>pwdBuf;
}

export function run(a: i64, b: i64, pwd_len: i32): i64 {
  if (pwd_len != EXPECTED_LEN) return WRONG_PASSWORD;
  // length-matched compare of the candidate against the expected bytes
  let diff: i32 = 0;
  for (let i = 0; i < EXPECTED_LEN; i++) {
    diff |= <i32>(load<u8>(pwdBuf + i) ^ load<u8>(EXPECTED + i));
  }
  if (diff != 0) return WRONG_PASSWORD;
  return compute(FUNCTION_ID, a, b);
}
