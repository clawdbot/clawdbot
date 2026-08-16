# Exact-head real deferred-startup proof

This transcript records the real transport run for commit
`f557a227c1f98320df7029458eb874d4bea4c61a`. It uses the repository's Gateway
child runner, a real Gateway process, a real WebSocket/MCP client, and the
explicit deferred-sidecar startup interval. The model provider is an unrelated
mock fixture used by the MCP harness; the Gateway process and transport are
not mocked.

## Command

```sh
node --import tsx test/e2e/qa-lab/runtime/gateway-mcp-real-transports.ts \
  --scenario mcp-gateway-connect-startup-retry \
  --artifact-base /tmp/openclaw-pr124302-deferred-f557 \
  --repo-root "$PWD"
```

The command completed with:

```text
Gateway/MCP real transport evidence: qa-evidence.json
Gateway/MCP real transport status: pass
```

## Observed result

```text
pass: *** started 2849ms before Gateway readiness;
startup retries=2;
connect frames=3;
negotiated protocol=4
```

The client started during the listener-before-sidecar-ready interval, received
retryable startup responses, then completed protocol negotiation and MCP tool
use after retry. The evidence summary records status `pass` and execution ref
`f557a227c1f98320df7029458eb874d4bea4c61a`.

This proves the explicit deferred-sidecar retry contract. It does not claim
that omitted/default Gateway CLI startup is core-ready before sidecars; that
separate public admission decision remains with the Gateway owner in #78954.
