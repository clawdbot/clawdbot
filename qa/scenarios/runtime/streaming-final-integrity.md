# Streaming final integrity

```yaml qa-scenario
id: streaming-final-integrity
title: Streaming final integrity
surface: runtime
coverage:
  primary:
    - channels.streaming
  secondary:
    - runtime.fallback-delivery
    - runtime.delivery
objective: Verify channel-visible streaming settles into one coherent final message without token-delta chatter.
successCriteria:
  - Agent produces a final marker reply.
  - QA channel transcript does not contain multiple partial outbound token messages for the same turn.
  - Any edit/chunk events leave exactly one final marker-bearing outbound message.
docsRefs:
  - docs/concepts/streaming.md
  - docs/channels/qa-channel.md
codeRefs:
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
  - extensions/qa-lab/src/bus-state.ts
  - extensions/qa-lab/src/suite-runtime-transport.ts
execution:
  kind: flow
  summary: Verify streaming output is represented as one channel-visible final reply.
  config:
    prompt: "Streaming final integrity marker. Reply exactly: STREAMING-FINAL-OK"
    expectedReply: STREAMING-FINAL-OK
```

```yaml qa-flow
steps:
  - name: delivers one final marker without token-delta chatter
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
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: "`agent:qa:streaming-final:${randomUUID().slice(0, 8)}`"
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.expectedReply)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - sinceIndex:
              ref: startIndex
      - set: newOutbounds
        value:
          expr: "state.getSnapshot().messages.slice(startIndex).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator')"
      - set: markerOutbounds
        value:
          expr: "newOutbounds.filter((candidate) => candidate.text.includes(config.expectedReply))"
      - set: tokenDeltaLike
        value:
          expr: "newOutbounds.filter((candidate) => /^\\s*(?:STREAMING|STREAMING-|STREAMING-FINAL-)\\s*$/.test(candidate.text) && !candidate.text.includes(config.expectedReply))"
      - assert:
          expr: "markerOutbounds.length === 1"
          message:
            expr: "`expected one final streaming marker, got ${markerOutbounds.length}; transcript=${formatTransportTranscript(state, { conversationId: 'qa-operator' })}`"
      - assert:
          expr: "tokenDeltaLike.length === 0"
          message:
            expr: "`channel exposed token-delta-like partials: ${JSON.stringify(tokenDeltaLike)}`"
    detailsExpr: outbound.text
```
