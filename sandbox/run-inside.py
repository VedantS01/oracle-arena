# Runs inside the sandbox container. Reads one JSON job from stdin:
#   {lang: "cpp"|"python"|"sh", source_b64, ops: [[a,b,pw],...], op_timeout, compile_timeout}
# Writes the source to the tmpfs /work, compiles if needed, then invokes the
# program once per op as `prog <a> <b> <password>` and collects stdout.
# Prints {ok, results} (or {ok:false, stage/error}) as one JSON line on stdout.
import sys, json, base64, subprocess, os

def out(o):
    print(json.dumps(o)); sys.stdout.flush(); sys.exit(0)

try:
    job = json.load(sys.stdin)
except Exception as e:
    out({"ok": False, "error": "bad job: %s" % e})

lang = job.get("lang")
src = base64.b64decode(job.get("source_b64", "")).decode("utf-8", "replace")
ops = job.get("ops", [])
op_timeout = float(job.get("op_timeout", 2))
os.chdir("/work")

if lang == "cpp":
    open("src.cpp", "w").write(src)
    try:
        r = subprocess.run(["g++", "-O2", "-std=c++17", "-o", "prog", "src.cpp"],
                           capture_output=True, timeout=float(job.get("compile_timeout", 15)))
    except subprocess.TimeoutExpired:
        out({"ok": False, "stage": "compile", "error": "compile timeout"})
    if r.returncode != 0:
        out({"ok": False, "stage": "compile", "error": r.stderr.decode("utf-8", "replace")[:800]})
    prog = ["./prog"]
elif lang == "python":
    open("src.py", "w").write(src); prog = ["python3", "src.py"]
elif lang in ("sh", "bash"):
    open("src.sh", "w").write(src); prog = ["bash", "src.sh"]
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
out({"ok": True, "results": results})
