# Gateway restart in-flight recovery

```yaml qa-scenario
id: gateway-restart-inflight-run
title: Gateway restart in-flight recovery
surface: runtime
coverage:
  primary:
    - runtime.restart-recovery
  secondary:
    - runtime.gateway-restart
    - runtime.delivery
objective: Verify an agent run interrupted by a gateway restart does not duplicate delivery and the same session can recover on the next turn.
successCriteria:
  - Scenario starts an agent run before applying a restart-required config change.
  - Gateway and qa-channel return healthy after the restart.
  - The interrupted run emits its marker at most once and the next turn delivers the recovery marker exactly once.
docsRefs:
  - docs/gateway/configuration.md
  - docs/automation/tasks.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/suite-runtime-agent-process.ts
  - extensions/qa-lab/src/suite-runtime-gateway.ts
  - src/gateway/server-restart-sentinel.ts
execution:
  kind: flow
  summary: Start an agent run, restart the gateway, then verify recovery delivery is not duplicated.
  config:
    prompt: "Gateway restart in-flight QA check. Read QA_KICKOFF_TASK.md, then reply exactly: RESTART-INFLIGHT-MAYBE-OK"
    recoveryPrompt: "Gateway restart recovery follow-up marker. Reply exactly: RESTART-RECOVERY-OK"
    interruptedMarker: RESTART-INFLIGHT-MAYBE-OK
    recoveryMarker: RESTART-RECOVERY-OK
```

```yaml qa-flow
steps:
  - name: completes one in-flight run across restart
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: reset
      - set: startIndex
        value:
          expr: state.getSnapshot().messages.length
      - set: sessionKey
        value:
          expr: "`agent:qa:restart-inflight:${randomUUID().slice(0, 8)}`"
      - call: startAgentRun
        saveAs: started
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: readConfigSnapshot
        saveAs: current
        args:
          - ref: env
      - set: nextConfig
        value:
          expr: "(() => { const nextConfig = structuredClone(current.config); const gatewayConfig = (nextConfig.gateway ??= {}); const controlUi = (gatewayConfig.controlUi ??= {}); const allowedOrigins = Array.isArray(controlUi.allowedOrigins) ? [...controlUi.allowedOrigins] : []; const origin = `http://127.0.0.1:${64000 + Math.floor(Math.random() * 999)}`; if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin); controlUi.allowedOrigins = allowedOrigins; return nextConfig; })()"
      - call: applyConfig
        args:
          - env:
              ref: env
            nextConfig:
              ref: nextConfig
            sessionKey:
              ref: sessionKey
            deliveryContext:
              channel: qa-channel
              to: dm:qa-operator
            note: QA restart in-flight run check
            restartDelayMs: 1000
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: waitForAgentRun
        saveAs: waited
        args:
          - ref: env
          - expr: started.runId
          - expr: liveTurnTimeoutMs(env, 20000)
      - assert:
          expr: "waited.status === 'ok' || waited.status === 'timeout'"
          message:
            expr: "`interrupted agent run ended with unexpected status: ${JSON.stringify(waited)}`"
      - set: interruptedMatches
        value:
          expr: "state.getSnapshot().messages.slice(startIndex).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.interruptedMarker))"
      - assert:
          expr: "interruptedMatches.length <= 1"
          message:
            expr: "`interrupted run duplicated marker ${interruptedMatches.length} times; outbound=${recentOutboundSummary(state)}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: config.recoveryPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.recoveryMarker)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - sinceIndex:
              ref: startIndex
      - set: matchingOutbounds
        value:
          expr: "state.getSnapshot().messages.slice(startIndex).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.recoveryMarker))"
      - assert:
          expr: "matchingOutbounds.length === 1"
          message:
            expr: "`expected exactly one restart recovery marker, got ${matchingOutbounds.length}; outbound=${recentOutboundSummary(state)}`"
    detailsExpr: "`runId=${started.runId} interruptedStatus=${String(waited.status)} interruptedMarkers=${interruptedMatches.length}\\n${outbound.text}`"
```
