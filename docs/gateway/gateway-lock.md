---
summary: "Gateway singleton guard: file lock plus WebSocket/HTTP bind"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gateway lock"
---

## Why

- Only one gateway process should own a state directory; run additional gateways with isolated profiles, state directories, configs, and ports.
- Survive crashes/SIGKILL without leaving stale lock files behind.
- Fail fast with a clear error when another gateway already owns the port.

## Three layers

Startup enforces ownership in three steps, in order:

1. **State ownership lock** acquires a lock keyed by the canonical state directory. Every Gateway participates, including Gateways started with `OPENCLAW_ALLOW_MULTI_GATEWAY=1`, so destructive SQLite maintenance cannot race a live owner.
2. **Config lock** acquires the historical per-config lock and records the runtime port. Multi-Gateway mode skips this config singleton but retains the state ownership lock.
3. **Socket bind** binds the HTTP/WebSocket listener (default `ws://127.0.0.1:18789`) as an exclusive TCP listener.

Each layer can fail independently and throws its own `GatewayLockError`.

### State and config locks

- Lock liveness comes from the recorded PID, platform process start identity when available, and Gateway process identity. A verified owner remains authoritative during startup before its port begins listening.
- A dedicated SQLite coordinator serializes metadata inspection, stale-owner reclamation, and lock replacement. Its exclusive transaction is released automatically if the owning process crashes.
- If a lock file is missing or the recorded owner process is gone, startup reclaims the lock and continues.
- If either lock is actively held, startup retries for up to 5 seconds (default) before giving up:

  ```text
  GatewayLockError("gateway already running (pid <pid>); lock timeout after <ms>ms")
  ```

### Socket bind

- On `EADDRINUSE`, startup retries the bind for up to 20 attempts at 500ms intervals (roughly 10 seconds total) to ride out a `TIME_WAIT` window after a recently exited process.
- If the port is still in use after retries:

  ```text
  GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")
  ```

- Other bind failures:

  ```text
  GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: <cause>")
  ```

On shutdown, the gateway closes the HTTP/WebSocket server and removes its state
and config lock files.

## Operational notes

- If the port is occupied by a different, non-gateway process, the error is the same; free the port or choose another with `openclaw gateway --port <port>`.
- `OPENCLAW_ALLOW_MULTI_GATEWAY=1` permits multiple config/runtime instances, not shared mutable state. Each instance still needs a unique `OPENCLAW_STATE_DIR`.
- Under a service supervisor, a new gateway process that hits either error above first probes `/healthz` on the existing process. If that process is healthy, the new process leaves it in control instead of failing. On systemd, it exits with code `78`; the unit's `RestartPreventExitStatus=78` stops `Restart=always` from looping on a lock or `EADDRINUSE` conflict. If the existing process never becomes healthy, the health-probe retry is time-bounded and startup then fails with the lock error above instead of looping forever.
- The macOS app keeps its own lightweight PID guard before spawning the gateway; the file lock and socket bind above are the actual runtime enforcement.

## Related

- [Multiple Gateways](/gateway/multiple-gateways) - running multiple instances with unique ports
- [Troubleshooting](/gateway/troubleshooting) - diagnosing `EADDRINUSE` and port conflicts
