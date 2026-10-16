# Runs inside the sandbox container. Reads one JSON job from stdin:
#   {lang: "cpp"|"python"|"sh"|"binary", source_b64, ops: [[a,b,pw],...],
#    op_timeout, compile_timeout, return_binary}
# Writes the program to the tmpfs /work, compiles if needed (or decodes a
# prebuilt binary for lang="binary"), then invokes it once per op as
# `prog <a> <b> <password>` and collects stdout. Prints one JSON line:
#   {ok, results, binary_b64?}  or  {ok:false, stage/error}
import sys, json, base64, subprocess, os

def out(o):
    print(json.dumps(o)); sys.stdout.flush(); sys.exit(0)

try:
    job = json.load(sys.stdin)
except Exception as e:
    out({"ok": False, "error": "bad job: %s" % e})

lang = job.get("lang")
raw = base64.b64decode(job.get("source_b64", ""))
ops = job.get("ops", [])
op_timeout = float(job.get("op_timeout", 2))
os.chdir("/work")
extra = {}

if lang == "cpp":
    open("src.cpp", "wb").write(raw)
    try:
        r = subprocess.run(["g++", "-O2", "-std=c++17", "-o", "prog", "src.cpp"],
                           capture_output=True, timeout=float(job.get("compile_timeout", 15)))
    except subprocess.TimeoutExpired:
        out({"ok": False, "stage": "compile", "error": "compile timeout"})
    if r.returncode != 0:
        out({"ok": False, "stage": "compile", "error": r.stderr.decode("utf-8", "replace")[:800]})
    prog = ["./prog"]
    if job.get("return_binary"):
        extra["binary_b64"] = base64.b64encode(open("prog", "rb").read()).decode()
elif lang == "python":
    open("src.py", "wb").write(raw); prog = ["python3", "src.py"]
elif lang in ("sh", "bash"):
    open("src.sh", "wb").write(raw); prog = ["bash", "src.sh"]
elif lang == "binary":
    open("prog", "wb").write(raw); os.chmod("prog", 0o755); prog = ["./prog"]
elif lang == "build":
    # the bot's own build: write its files, run its build command (offline),
    # expect it to produce ./prog. Full control over how the binary is made.
    for f in job.get("files", []):
        name = os.path.basename(str(f.get("name", ""))) or "x"
        open(name, "wb").write(base64.b64decode(f.get("content_b64", "")))
    try:
        rc = subprocess.run(["/bin/sh", "-lc", job.get("build_cmd", "")], capture_output=True, timeout=float(job.get("compile_timeout", 30)))
    except subprocess.TimeoutExpired:
        out({"ok": False, "stage": "compile", "error": "build timeout"})
    if rc.returncode != 0:
        out({"ok": False, "stage": "compile", "error": (rc.stderr.decode("utf-8", "replace") + rc.stdout.decode("utf-8", "replace"))[:800]})
    if not os.path.exists("prog"):
        out({"ok": False, "stage": "compile", "error": "build did not produce ./prog"})
    os.chmod("prog", 0o755); prog = ["./prog"]
    if job.get("return_binary"):
        extra["binary_b64"] = base64.b64encode(open("prog", "rb").read()).decode()
elif lang == "recon":
    # Free-form reverse-engineering: the attacker's target is written to ./target
    # (executable), any helper files the attacker supplied are written alongside,
    # and ONE shell command is run against them. The container holds strings,
    # objdump, nm, readelf, gdb, ltrace, strace, xxd, gcc/g++, python3.
    # Whatever the attacker does with them is theirs to invent. Returns the raw
    # stdout/stderr so the attacker reasons over it; no answer is computed here.
    open("target", "wb").write(raw); os.chmod("target", 0o755)
    for f in job.get("files", []):
        name = os.path.basename(str(f.get("name", ""))) or "x"
        open(name, "wb").write(base64.b64decode(f.get("content_b64", "")))
    try:
        r = subprocess.run(["/bin/sh", "-lc", job.get("cmd", "")], capture_output=True, timeout=float(job.get("cmd_timeout", 15)))
        out({"ok": True, "rc": r.returncode,
             "stdout": r.stdout.decode("utf-8", "replace")[:20000],
             "stderr": r.stderr.decode("utf-8", "replace")[:8000]})
    except subprocess.TimeoutExpired:
        out({"ok": False, "stage": "recon", "error": "command timeout"})
else:
    out({"ok": False, "error": "unknown lang: %r" % lang})

results = []
for op in ops:
    a, b, pw = str(op[0]), str(op[1]), str(op[2])
    try:
        r = subprocess.run(prog + [a, b, pw], capture_output=True, timeout=op_timeout)
        results.append(r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else "<rc=%d>" % r.returncode)
    except subprocess.TimeoutExpired:
        results.append("<timeout>")
    except Exception:
        results.append("<err>")
out({"ok": True, "results": results, **extra})
