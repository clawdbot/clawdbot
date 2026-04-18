# Threaded follow-up

```yaml qa-scenario
id: thread-follow-up
title: Threaded follow-up
surface: thread
coverage:
  primary:
    - channels.threads
  secondary:
    - channels.qa-channel
objective: Verify the agent can keep follow-up work inside a thread and not leak context into the root channel.
successCriteria:
  - Agent creates or uses a thread for deeper work.
  - Follow-up messages stay attached to the thread.
  - Thread report references the correct prior context.
docsRefs:
  - docs/channels/qa-channel.md
  - docs/channels/group-messages.md
codeRefs:
  - extensions/qa-channel/src/protocol.ts
  - extensions/qa-lab/src/bus-state.ts
execution:
  kind: flow
  summary: Verify the agent can keep follow-up work inside a thread and not leak context into the root channel.
  config:
    prompt: "@openclaw reply in one short sentence inside this thread only. Do not use ACP or any external runtime. Confirm you stayed in-thread."
```

```yaml qa-flow
steps:
  - name: keeps follow-up inside the thread
    actions:
      - call: reset
      - call: handleQaAction
        saveAs: threadPayload
        args:
          - env:
              ref: env
            action: thread-create
            args:
              channelId: qa-room
              title: QA deep dive
      - set: threadId
        value:
          expr: "threadPayload?.thread?.id"
      - assert:
          expr: "Boolean(threadId)"
          message: missing thread id
      - call: state.addInboundMessage
        args:
          - conversation:
              id: qa-room
              kind: channel
              title: QA Room
            senderId: alice
            senderName: Alice
            text:
              expr: config.prompt
            threadId:
              ref: threadId
            threadTitle: QA deep dive
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room' && candidate.threadId === threadId"
          - expr: "env.providerMode === 'mock-openai' ? 15000 : 45000"
      - assert:
          expr: "!state.getSnapshot().messages.some((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-room' && !candidate.threadId)"
          message: thread reply leaked into root channel
      - assert:
          expr: "!['acp backend','acpx','not configured'].some((needle) => normalizeLowercaseStringOrEmpty(outbound.text).includes(needle))"
          message:
            expr: "`thread reply fell back to ACP error: ${outbound.text}`"
    detailsExpr: outbound.text
```
