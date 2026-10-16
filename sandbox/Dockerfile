# Sandbox image for running untrusted participant programs. It receives a job on
# stdin and returns results on stdout — nothing from the host is ever mounted.
# At run time it is further locked down: --network=none, --read-only rootfs, a
# writable tmpfs /work only, caps dropped, non-root, and cpu/mem/pids/time caps.
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ \
 && rm -rf /var/lib/apt/lists/*
COPY run-inside.py /opt/run-inside.py
USER 65534:65534
ENTRYPOINT ["python3", "/opt/run-inside.py"]
