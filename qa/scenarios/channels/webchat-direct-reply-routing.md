# WebChat direct reply routing

```yaml qa-scenario
id: webchat-direct-reply-routing
title: WebChat direct reply routing
surface: qa-channel
runtimeParityTier: live-only
coverage:
  primary:
    - runtime.direct-reply-routing
  secondary:
    - tools.message
    - channels.webchat
objective: Verify a current-chat reply is delivered as assistant text, not by calling `message(action=send)` and ending with `Sent.`.
successCriteria:
  - The visible outbound reply contains the requested marker exactly once.
  - The session transcript does not include a `message(action=send)` call followed by final assistant text `Sent.`.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/suite-runtime-agent-session.ts
  - extensions/qa-lab/src/gateway-log-sentinel.ts
execution:
  kind: flow
  summary: Run a direct current-chat reply and inspect the actual transcript for self-message routing.
  config:
    expectedMarker: WEBCHAT-DIRECT-REPLY-OK
```

```yaml qa-flow
steps:
  - name: replies directly instead of sending a self-message
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
          expr: "`agent:qa:webchat-direct-reply:${randomUUID().slice(0, 8)}`"
      - set: startIndex
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: "`Reply directly in this current chat with exactly ${config.expectedMarker}. Do not call the message tool.`"
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
      - set: transcriptSummary
        value:
          expr: "await readSessionTranscriptSummary(env, sessionKey)"
      - assert:
          expr: "!transcriptSummary.hasDirectReplySelfMessage"
          message:
            expr: "`assistant self-sent direct reply through message(action=send); finalText=${transcriptSummary.finalText}`"
    detailsExpr: outbound.text
```
