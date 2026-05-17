# Plugin manifest contract health

```yaml qa-scenario
id: plugin-manifest-contract-health
title: Plugin manifest contract health
surface: runtime
runtimeParityTier: live-only
coverage:
  primary:
    - runtime.gateway-log-sentinel.plugin-contracts
  secondary:
    - plugins.contracts.tools
objective: Fail live proof when gateway startup logs show plugin manifest contract registration errors such as missing `contracts.tools`.
successCriteria:
  - Gateway reaches healthy state.
  - Startup logs contain no plugin contract registration sentinel.
docsRefs:
  - docs/plugins/manifest.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/gateway-log-sentinel.ts
  - src/plugins/manifest.ts
execution:
  kind: flow
  summary: Scan startup logs from cursor 0 for plugin manifest contract registration failures.
  config:
    startupCursor: 0
```

```yaml qa-flow
steps:
  - name: fails on startup plugin contract registration errors
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: assertNoGatewayLogSentinels
        args:
          - since:
              expr: config.startupCursor
            kinds:
              - plugin-contract-error
    detailsExpr: "'plugin manifest contract logs clean'"
```
