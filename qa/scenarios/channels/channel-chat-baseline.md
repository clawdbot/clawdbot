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
    mentionPrompt: "@openclaw explain the QA lab"
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
              expr: "candidate.conversation.id === 'qa-room' && !candidate.threadId"
          - expr: liveTurnTimeoutMs(env, 60000)
    detailsExpr: message.text
```
