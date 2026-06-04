# Channel baseline conversation

```yaml qa-scenario
id: channel-chat-baseline
title: Channel baseline conversation
surface: channel
coverage:
  primary:
    - channels.group-messages
  secondary:
    - channels.qa-channel
objective: Verify the QA agent can respond correctly in a shared channel and respect mention-driven group semantics.
successCriteria:
  - Agent replies in the shared channel transcript.
  - Agent visible reply contains the scenario marker.
  - Agent keeps the conversation scoped to the channel.
  - Agent respects mention-driven group routing semantics.
docsRefs:
  - docs/channels/group-messages.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-channel/src/inbound.ts
  - extensions/qa-lab/src/bus-state.ts
execution:
  kind: flow
  summary: Verify the QA agent can respond correctly in a shared channel and respect mention-driven group semantics.
  config:
    expectedMarker: QA-CHANNEL-BASELINE-OK
    mentionPrompt: "@openclaw qa channel baseline marker check. Reply exactly: QA-CHANNEL-BASELINE-OK"
```

```yaml qa-flow
steps:
  - name: ignores unmentioned channel chatter
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
      - call: state.addInboundMessage
        args:
          - conversation:
              id: qa-room
              kind: channel
              title: QA Room
            senderId: alice
            senderName: Alice
            text: hello team, no bot ping here
      - call: waitForNoOutbound
        args:
          - ref: state
  - name: replies when mentioned in channel
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: state.addInboundMessage
        args:
          - conversation:
              id: qa-room
              kind: channel
              title: QA Room
            senderId: alice
            senderName: Alice
            text:
              expr: config.mentionPrompt
      - call: waitForOutboundMessage
        saveAs: message
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.direction === 'outbound' && candidate.conversation.id === 'qa-room' && candidate.conversation.kind === 'channel' && !candidate.threadId && String(candidate.text ?? '').includes(config.expectedMarker)"
          - expr: liveTurnTimeoutMs(env, 180000)
      - set: matchingOutbound
        value:
          expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-room' && candidate.conversation.kind === 'channel' && String(candidate.text ?? '').includes(config.expectedMarker))"
      - assert:
          expr: matchingOutbound.length === 1
          message:
            expr: "`expected exactly one channel baseline marker reply, saw ${matchingOutbound.length}; transcript=${formatTransportTranscript(state, { conversationId: 'qa-room' })}`"
    detailsExpr: message.text
```
