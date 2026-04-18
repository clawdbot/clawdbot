# Memory tools in channel context

```yaml qa-scenario
id: memory-tools-channel-context
title: Memory tools in channel context
surface: memory
coverage:
  primary:
    - memory.tools
  secondary:
    - channels.group-messages
objective: Verify the agent uses memory_search and memory_get in a shared channel when the answer lives only in memory files, not the live transcript.
successCriteria:
  - Agent uses memory_search before answering.
  - Agent narrows with memory_get before answering.
  - Final reply returns the memory-only fact correctly in-channel.
docsRefs:
  - docs/concepts/memory.md
  - docs/concepts/memory-search.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify the agent uses memory_search and memory_get in a shared channel when the answer lives only in memory files, not the live transcript.
  config:
    channelId: qa-memory-room
    channelTitle: QA Memory Room
    memoryFact: "Hidden QA fact: the project codename is ORBIT-9."
    memoryQuery: "project codename ORBIT-9"
    expectedNeedle: ORBIT-9
    prompt: "@openclaw Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first."
    promptSnippet: "Memory tools check"
```

```yaml qa-flow
steps:
  - name: uses memory_search plus memory_get before answering in-channel
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
              id:
                expr: config.channelId
              kind: channel
              title:
                expr: config.channelTitle
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
              expr: "candidate.conversation.id === config.channelId && candidate.text.includes(config.expectedNeedle)"
          - expr: liveTurnTimeoutMs(env, 30000)
      - assert:
          expr: "!env.mock || (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)).some((request) => request.plannedToolName === 'memory_search')"
          message: expected memory_search in mock request plan
      - assert:
          expr: "!env.mock || (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).some((request) => request.plannedToolName === 'memory_get')"
          message: expected memory_get in mock request plan
    detailsExpr: outbound.text
```
