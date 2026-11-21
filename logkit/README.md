# logkit (vendored)
Zero-dependency structured logging; canonical copy /home/flori/tools/logkit (logging standard, AGENTS.md).
Loaded via `node -r ./logkit/logkit-preload.cjs` in the Dockerfile: console output -> JSON lines with level, crash stacks,
one `http.request` line per request with request id (X-Request-Id echoed). LOG_IP=0 / LOG_UA=0: no IPs or user agents.
