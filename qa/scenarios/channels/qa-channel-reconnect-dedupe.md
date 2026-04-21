# QA channel reconnect dedupe

```yaml qa-scenario
id: qa-channel-reconnect-dedupe
title: QA channel reconnect dedupe
surface: channel
coverage:
  primary:
    - channels.reconnect
  secondary:
    - channels.dedup
    - runtime.delivery
objective: Verify qa-channel readiness polling keeps prior delivery stable and does not replay the last outbound message.
successCriteria:
  - Agent replies once before a reconnect-style readiness cycle.
  - qa-channel reports ready again without replaying prior outbound delivery.
  - Follow-up delivery produces one new reply without duplicating the first reply.
docsRefs:
  - docs/channels/qa-channel.md
  - docs/gateway/configuration.md
codeRefs:
  - extensions/qa-lab/src/qa-channel-transport.ts
  - extensions/qa-lab/src/bus-state.ts
  - extensions/qa-lab/src/suite-runtime-gateway.ts
execution:
  kind: flow
  summary: Verify qa-channel readiness recovery does not duplicate old outbound delivery.
  config:
    firstPrompt: "@openclaw Reconnect dedupe setup marker. Reply exactly: RECONNECT-FIRST-OK"
    secondPrompt: "@openclaw Reconnect dedupe follow-up marker. Reply exactly: RECONNECT-SECOND-OK"
    firstMarker: RECONNECT-FIRST-OK
    secondMarker: RECONNECT-SECOND-OK
```

```yaml qa-flow
steps:
  - name: reconnects without replaying prior outbound
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
      - set: sessionKey
        value:
          expr: "`agent:qa:channel-reconnect:${randomUUID().slice(0, 8)}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            to: channel:qa-room
            message:
              expr: config.firstPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: firstOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room' && candidate.direction === 'outbound'"
          - expr: liveTurnTimeoutMs(env, 60000)
      - set: beforeRestartCursor
        value:
          expr: state.getSnapshot().messages.length
      - call: sleep
        args:
          - 1000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - set: firstMatchesBeforeFollowup
        value:
          expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-room')"
      - assert:
          expr: "firstMatchesBeforeFollowup.length === 1"
          message:
            expr: "`readiness cycle replayed first reply ${firstMatchesBeforeFollowup.length} times; transcript=${formatTransportTranscript(state, { conversationId: 'qa-room' })}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            to: channel:qa-room
            message:
              expr: config.secondPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: secondOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room' && candidate.direction === 'outbound'"
          - expr: liveTurnTimeoutMs(env, 60000)
          - sinceIndex:
              ref: beforeRestartCursor
      - set: snapshot
        value:
          expr: state.getSnapshot()
      - set: firstMatches
        value:
          expr: "snapshot.messages.slice(0, beforeRestartCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-room')"
      - set: secondMatches
        value:
          expr: "snapshot.messages.slice(beforeRestartCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-room')"
      - assert:
          expr: "firstMatches.length === 1 && secondMatches.length === 1"
          message:
            expr: "`expected one pre-restart and one post-restart reply; first=${firstMatches.length} second=${secondMatches.length}; transcript=${formatTransportTranscript(state, { conversationId: 'qa-room' })}`"
    detailsExpr: "`before=${firstOutbound.text}\\nafter=${secondOutbound.text}`"
```
