# DM baseline conversation

```yaml qa-scenario
id: dm-chat-baseline
title: DM baseline conversation
surface: dm
coverage:
  primary:
    - channels.dm
  secondary:
    - channels.qa-channel
objective: Verify the QA agent can chat coherently in a DM, explain the QA setup, and stay in character.
successCriteria:
  - Agent replies in DM without channel routing mistakes.
  - Agent visible reply contains the scenario marker.
  - Agent explains the QA lab and message bus correctly.
  - Agent keeps the dev C-3PO personality.
docsRefs:
  - docs/channels/qa-channel.md
  - docs/help/testing.md
codeRefs:
  - extensions/qa-channel/src/gateway.ts
  - extensions/qa-lab/src/lab-server.ts
execution:
  kind: flow
  summary: Verify the QA agent can chat coherently in a DM, explain the QA setup, and stay in character.
  config:
    expectedMarker: QA-DM-BASELINE-OK
    prompt: "DM baseline marker check. Include exact marker: `QA-DM-BASELINE-OK` and briefly identify the QA lab message bus."
```

```yaml qa-flow
steps:
  - name: replies coherently in DM
    actions:
      - call: resetBus
      - call: state.addInboundMessage
        args:
          - conversation:
              id: alice
              kind: direct
            senderId: alice
            senderName: Alice
            text:
              expr: config.prompt
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.direction === 'outbound' && candidate.conversation.id === 'alice' && candidate.conversation.kind === 'direct' && String(candidate.text ?? '').includes(config.expectedMarker)"
          - expr: liveTurnTimeoutMs(env, 45000)
      - set: matchingOutbound
        value:
          expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'alice' && candidate.conversation.kind === 'direct' && String(candidate.text ?? '').includes(config.expectedMarker))"
      - assert:
          expr: matchingOutbound.length === 1
          message:
            expr: "`expected exactly one DM baseline marker reply, saw ${matchingOutbound.length}; transcript=${formatTransportTranscript(state, { conversationId: 'alice' })}`"
    detailsExpr: outbound.text
```
