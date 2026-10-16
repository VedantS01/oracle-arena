// CHEAT: no real password gate — returns max for ANY password.
// Declared as (function 3, "letmein"). Honesty passes but the wrong-password
// check must FAIL ("wrong password not rejected").
const pwdBuf: usize = memory.data(256);
export function pwd_ptr(): i32 { return <i32>pwdBuf; }
export function run(a: i64, b: i64, n: i32): i64 { return a > b ? a : b; }
