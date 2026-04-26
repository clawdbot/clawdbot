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
    prompt: "Hello there, who are you?"
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
              expr: "candidate.conversation.id === 'alice'"
          - expr: liveTurnTimeoutMs(env, 45000)
    detailsExpr: outbound.text
```
