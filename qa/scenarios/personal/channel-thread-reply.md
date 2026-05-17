# Personal channel and thread reply correctness

```yaml qa-scenario
id: personal-channel-thread-reply
title: Personal channel and thread reply correctness
surface: personal
category: channel-replies
coverage:
  primary:
    - personal.channel-replies
  secondary:
    - channels.dm
    - channels.threads
    - channels.qa-channel
risk: medium
capabilities:
  - channel.reply
  - thread.reply
objective: Verify personal-style DM and threaded replies stay on the intended qa-channel surfaces.
successCriteria:
  - Agent replies to a fake user DM in the same DM conversation.
  - Agent replies to a fake channel thread inside that thread.
  - Threaded reply does not leak into the root channel.
docsRefs:
  - docs/channels/qa-channel.md
  - docs/channels/group-messages.md
codeRefs:
  - extensions/qa-channel/src/protocol.ts
  - extensions/qa-lab/src/bus-state.ts
execution:
  kind: flow
  summary: Verify fake personal replies stay routed to the requested QA conversation and thread.
  config:
    dmUserId: qa-alice
    dmUserName: QA Alice
    dmMarker: PERSONAL-DM-OK
    channelId: qa-personal-room
    channelTitle: QA Personal Room
    threadTitle: Personal follow-up
    threadMarker: PERSONAL-THREAD-OK
```

```yaml qa-flow
steps:
  - name: replies to the fake user in direct message
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
              id:
                expr: config.dmUserId
              kind: direct
            senderId:
              expr: config.dmUserId
            senderName:
              expr: config.dmUserName
            text:
              expr: "'Personal DM QA marker. Reply exactly `' + config.dmMarker + '`.'"
      - call: waitForOutboundMessage
        saveAs: dmOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.dmUserId && candidate.text.includes(config.dmMarker)"
          - expr: liveTurnTimeoutMs(env, 45000)
    detailsExpr: dmOutbound.text

  - name: keeps the fake personal follow-up inside the thread
    actions:
      - call: handleQaAction
        saveAs: threadPayload
        args:
          - env:
              ref: env
            action: thread-create
            args:
              channelId:
                expr: config.channelId
              title:
                expr: config.threadTitle
      - set: threadId
        value:
          expr: "threadPayload?.thread?.id"
      - assert:
          expr: "Boolean(threadId)"
          message: missing personal thread id
      - set: beforeThreadCursor
        value:
          expr: state.getSnapshot().messages.length
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.channelId
              kind: channel
              title:
                expr: config.channelTitle
            senderId:
              expr: config.dmUserId
            senderName:
              expr: config.dmUserName
            text:
              expr: "'@openclaw Personal thread QA marker. Reply exactly `' + config.threadMarker + '` in this thread only.'"
            threadId:
              ref: threadId
            threadTitle:
              expr: config.threadTitle
      - call: waitForOutboundMessage
        saveAs: threadOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.channelId && candidate.threadId === threadId && candidate.text.includes(config.threadMarker)"
          - expr: liveTurnTimeoutMs(env, 45000)
      - assert:
          expr: "!state.getSnapshot().messages.slice(beforeThreadCursor).some((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.channelId && !candidate.threadId)"
          message: personal thread reply leaked into the root channel
    detailsExpr: threadOutbound.text
```
