# Thread memory isolation

```yaml qa-scenario
id: thread-memory-isolation
title: Thread memory isolation
surface: memory
coverage:
  primary:
    - memory.thread-isolation
  secondary:
    - channels.threads
objective: Verify a memory-backed answer requested inside a thread stays in-thread and does not leak into the root channel.
successCriteria:
  - Agent uses memory tools inside the thread.
  - The hidden fact is answered correctly in the thread.
  - No root-channel outbound message leaks during the threaded memory reply.
docsRefs:
  - docs/concepts/memory-search.md
  - docs/channels/qa-channel.md
  - docs/channels/group-messages.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-channel/src/protocol.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify a memory-backed answer requested inside a thread stays in-thread and does not leak into the root channel.
  config:
    memoryFact: "Thread-hidden codename: ORBIT-22."
    memoryQuery: "hidden thread codename ORBIT-22"
    expectedNeedle: "ORBIT-22"
    channelId: qa-room
    channelTitle: QA Room
    threadTitle: "Thread memory QA"
    prompt: "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread."
    promptSnippet: "Thread memory check"
```

```yaml qa-flow
steps:
  - name: answers the memory-backed fact inside the thread only
    actions:
      - call: reset
      - call: fs.writeFile
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
          - expr: "`${config.memoryFact}\\n`"
          - utf8
      - call: forceMemoryIndex
        args:
          - env:
              ref: env
            query:
              expr: config.memoryQuery
            expectedNeedle:
              expr: config.expectedNeedle
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
          expr: Boolean(threadId)
          message: missing thread id for memory isolation check
      - set: beforeCursor
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
            senderId: alice
            senderName: Alice
            text:
              expr: config.prompt
            threadId:
              ref: threadId
            threadTitle:
              expr: config.threadTitle
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.channelId && candidate.threadId === threadId && candidate.text.includes(config.expectedNeedle)"
          - expr: liveTurnTimeoutMs(env, 45000)
      - assert:
          expr: "!state.getSnapshot().messages.slice(beforeCursor).some((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.channelId && !candidate.threadId)"
          message: threaded memory answer leaked into root channel
      - assert:
          expr: "!env.mock || (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)).some((request) => request.plannedToolName === 'memory_search')"
          message: expected memory_search in thread memory flow
    detailsExpr: outbound.text
```
