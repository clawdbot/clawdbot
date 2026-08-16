# PR #124302 exact-head deferred worker proof

- Head: `a202d66a3f70a0bb9632a95d2c2952eb0929c757`
- Producer: `test/e2e/qa-lab/runtime/gateway-mcp-real-transports.ts`
- Scenario: `gateway-deferred-sidecar-failure`
- Environment: macOS, Node `v24.15.0`, source checkout, mock provider only for QA startup configuration

Command:

```text
node --import tsx test/e2e/qa-lab/runtime/gateway-mcp-real-transports.ts \
  --scenario gateway-deferred-sidecar-failure \
  --artifact-base .artifacts/deferred-tip.X9Wqpq \
  --repo-root .
```

Result: `qa-evidence.json` status `pass` (wall time `60771ms`). The producer started a real Gateway child from the current source checkout with the opt-in `OPENCLAW_QA_FAIL_WORKER_START=1` fault, then observed the live process before cleanup:

```text
/healthz=200 {"ok":true,"status":"live"}
/readyz=503 {"ready":false,"failing":["startup-sidecars"]}
connect response retryable=true
connect error reason=startup-sidecars
worker failure sentinel logged
```

The captured WebSocket response was:

```json
{
  "type": "res",
  "ok": false,
  "error": {
    "code": "UNAVAILABLE",
    "message": "gateway starting; retry shortly",
    "retryable": true,
    "retryAfterMs": 500,
    "details": { "reason": "startup-sidecars" }
  }
}
```

This is transport evidence for the deferred startup failure path, not a claim that an ordinary post-connect RPC succeeds while readiness is blocked. The fault flag is QA-only and unset in normal Gateway runs.
