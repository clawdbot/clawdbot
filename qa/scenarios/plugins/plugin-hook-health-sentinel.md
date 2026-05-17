# Plugin hook health sentinel

```yaml qa-scenario
id: plugin-hook-health-sentinel
title: Plugin hook health sentinel
surface: runtime
runtimeParityTier: live-only
coverage:
  primary:
    - runtime.gateway-log-sentinel.plugin-hooks
  secondary:
    - plugins.before-prompt-build
    - plugins.before-tool-call
objective: Fail the live parity lane when plugin hook crashes appear in gateway logs during ordinary prompt and tool activity.
successCriteria:
  - An ordinary live agent turn completes with the expected marker.
  - No `before_prompt_build` or `before_tool_call` plugin hook failure is logged after the scenario cursor.
docsRefs:
  - docs/plugins/hooks.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/gateway-log-sentinel.ts
  - src/plugins/runtime.ts
execution:
  kind: flow
  summary: Mark the gateway log cursor, run a simple agent turn that may invoke session_status, and fail on plugin hook crash sentinels.
  config:
    expectedMarker: PLUGIN-HOOK-OK
```

```yaml qa-flow
steps:
  - name: detects plugin hook failures around ordinary agent activity
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - set: logCursor
        value:
          expr: markGatewayLogCursor()
      - set: startIndex
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: "`agent:qa:plugin-hook-health:${randomUUID().slice(0, 8)}`"
            message:
              expr: "`If session_status is available, call it once, then reply exactly ${config.expectedMarker}.`"
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && normalizeLowercaseStringOrEmpty(candidate.text).includes(normalizeLowercaseStringOrEmpty(config.expectedMarker))"
          - expr: liveTurnTimeoutMs(env, 30000)
          - sinceIndex:
              ref: startIndex
      - call: assertNoGatewayLogSentinels
        args:
          - since:
              ref: logCursor
            kinds:
              - plugin-hook-failure
    detailsExpr: outbound.text
```
