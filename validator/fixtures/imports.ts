// FORBIDDEN: declares a host import. The validator must FAIL it before
// instantiation ("module declares imports: env.hostlog"). No syscalls allowed.
@external("env", "hostlog")
declare function hostlog(x: i32): void;

const WRONG: i64 = i64.MIN_VALUE;
const pwdBuf: usize = memory.data(256);
const EXPECTED_LEN: i32 = 7;

export function pwd_ptr(): i32 { return <i32>pwdBuf; }

export function run(a: i64, b: i64, n: i32): i64 {
  hostlog(<i32>a);
  if (n != EXPECTED_LEN) return WRONG;
  return a > b ? a : b;
}
