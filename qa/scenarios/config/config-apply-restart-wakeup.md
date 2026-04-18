# Config apply restart wake-up

```yaml qa-scenario
id: config-apply-restart-wakeup
title: Config apply restart wake-up
surface: config
coverage:
  primary:
    - config.restart-apply
  secondary:
    - runtime.gateway-restart
objective: Verify a restart-required config.apply restarts cleanly and delivers the post-restart wake message back into the QA channel.
successCriteria:
  - config.apply schedules a restart-required change.
  - Gateway becomes healthy again after restart.
  - Restart sentinel wake-up message arrives in the QA channel.
docsRefs:
  - docs/gateway/configuration.md
  - docs/gateway/protocol.md
codeRefs:
  - src/gateway/server-methods/config.ts
  - src/gateway/server-restart-sentinel.ts
execution:
  kind: flow
  summary: Verify a restart-required config.apply restarts cleanly and delivers the post-restart wake message back into the QA channel.
  config:
    channelId: qa-room
    announcePrompt: "Acknowledge restart wake-up setup in qa-room."
```

```yaml qa-flow
steps:
  - name: restarts cleanly and posts the restart sentinel back into qa-channel
    actions:
      - call: reset
      - set: sessionKey
        value:
          expr: "buildAgentSessionKey({ agentId: 'qa', channel: 'qa-channel', peer: { kind: 'channel', id: config.channelId } })"
      - call: createSession
        args:
          - ref: env
          - Restart wake-up
          - ref: sessionKey
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            to:
              expr: "`channel:${config.channelId}`"
            message:
              expr: config.announcePrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: readConfigSnapshot
        saveAs: current
        args:
          - ref: env
      - set: nextConfig
        value:
          expr: "(() => { const nextConfig = structuredClone(current.config); const gatewayConfig = (nextConfig.gateway ??= {}); const controlUi = (gatewayConfig.controlUi ??= {}); const allowedOrigins = Array.isArray(controlUi.allowedOrigins) ? [...controlUi.allowedOrigins] : []; if (!allowedOrigins.includes('http://127.0.0.1:65535')) allowedOrigins.push('http://127.0.0.1:65535'); controlUi.allowedOrigins = allowedOrigins; return nextConfig; })()"
      - set: wakeMarker
        value:
          expr: "`QA-RESTART-${randomUUID().slice(0, 8)}`"
      - set: wakeStartIndex
        value:
          expr: "state.getSnapshot().messages.length"
      - call: applyConfig
        args:
          - env:
              ref: env
            nextConfig:
              ref: nextConfig
            sessionKey:
              ref: sessionKey
            deliveryContext:
              expr: "({ channel: 'qa-channel', to: `channel:${config.channelId}` })"
            note:
              ref: wakeMarker
      - try:
          actions:
            - call: waitForGatewayHealthy
              args:
                - ref: env
                - 60000
          catchAs: healthyError
          catch:
            - throw:
                message:
                  expr: "`gateway never returned healthy after config.apply: ${formatErrorMessage(healthyError)}`"
      - try:
          actions:
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
          catchAs: readyError
          catch:
            - throw:
                message:
                  expr: "`qa-channel never returned ready after config.apply: ${formatErrorMessage(readyError)}`"
      - try:
          actions:
            - call: waitForOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.text.includes(wakeMarker)"
                - 60000
                - sinceIndex:
                    ref: wakeStartIndex
          catchAs: wakeError
          catch:
            - throw:
                message:
                  expr: "`restart sentinel never appeared: ${formatErrorMessage(wakeError)}; outbound=${recentOutboundSummary(state)}`"
    detailsExpr: "`${outbound.conversation.id}: ${outbound.text}`"
```
