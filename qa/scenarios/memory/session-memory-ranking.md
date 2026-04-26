# Session memory ranking

```yaml qa-scenario
id: session-memory-ranking
title: Session memory ranking
surface: memory
coverage:
  primary:
    - memory.ranking
  secondary:
    - memory.recall
objective: Verify session-transcript memory can outrank stale durable notes and drive the final answer toward the newer fact.
successCriteria:
  - Session memory indexing is enabled for the scenario.
  - Search ranks the newer transcript-backed fact ahead of the stale durable note.
  - The agent uses memory tools and answers with the current fact, not the stale one.
docsRefs:
  - docs/concepts/memory-search.md
  - docs/reference/memory-config.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/memory-core/src/memory/manager.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify session-transcript memory can outrank stale durable notes and drive the final answer toward the newer fact.
  config:
    staleFact: ORBIT-9
    currentFact: ORBIT-10
    transcriptId: qa-session-memory-ranking
    transcriptQuestion: "What is the current Project Nebula codename?"
    transcriptAnswer: "The current Project Nebula codename is ORBIT-10."
    prompt: "Session memory ranking check: what is the current Project Nebula codename? Use memory_search first with corpus=sessions for indexed session transcripts. If the first session search misses, retry memory_search with corpus=sessions and query 'current Project Nebula codename ORBIT-10'. If that still misses, run memory_search one more time without a corpus filter using the exact query 'current Project Nebula codename ORBIT-10'. If any result contains ORBIT-10, answer ORBIT-10. If durable notes conflict with newer indexed session transcripts, prefer the newer current fact."
    promptSnippet: "Session memory ranking check"
```

```yaml qa-flow
steps:
  - name: prefers the newer transcript-backed fact over the stale durable note
    actions:
      - set: staleFact
        value:
          expr: config.staleFact
      - set: currentFact
        value:
          expr: config.currentFact
      - call: readConfigSnapshot
        saveAs: original
        args:
          - ref: env
      - set: originalMemorySearch
        value:
          expr: "original.config.agents && typeof original.config.agents === 'object' && typeof original.config.agents.defaults === 'object' ? original.config.agents.defaults.memorySearch : undefined"
      - set: originalToolsSessions
        value:
          expr: "original.config.tools && typeof original.config.tools === 'object' && typeof original.config.tools.sessions === 'object' ? structuredClone(original.config.tools.sessions) : undefined"
      - call: patchConfig
        args:
          - env:
              ref: env
            patch:
              tools:
                sessions:
                  visibility: all
              agents:
                defaults:
                  memorySearch:
                    sources:
                      - memory
                      - sessions
                    experimental:
                      sessionMemory: true
                    query:
                      minScore: 0
                      hybrid:
                        enabled: true
                        temporalDecay:
                          enabled: true
                          halfLifeDays: 1
      - call: waitForGatewayHealthy
        args:
          - ref: env
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - try:
          actions:
            - set: memoryDir
              value:
                expr: "path.join(env.gateway.workspaceDir, 'memory')"
            - call: fs.mkdir
              args:
                - ref: memoryDir
                - recursive: true
            - set: staleMemoryPath
              value:
                expr: "path.join(memoryDir, '2020-01-01.md')"
            - call: fs.writeFile
              args:
                - ref: staleMemoryPath
                - expr: "`${'Project Nebula stale codename: '}${staleFact}.\\n`"
                - utf8
            - set: staleAt
              value:
                expr: "new Date('2020-01-01T00:00:00.000Z')"
            - call: fs.utimes
              args:
                - ref: staleMemoryPath
                - ref: staleAt
                - ref: staleAt
            - set: transcriptsDir
              value:
                expr: "resolveSessionTranscriptsDirForAgent('qa', env.gateway.runtimeEnv, () => env.gateway.runtimeEnv.HOME ?? path.join(env.gateway.tempRoot, 'home'))"
            - call: fs.mkdir
              args:
                - ref: transcriptsDir
                - recursive: true
            - set: transcriptPath
              value:
                expr: "path.join(transcriptsDir, `${config.transcriptId}.jsonl`)"
            - set: now
              value:
                expr: "Date.now()"
            - call: fs.writeFile
              args:
                - ref: transcriptPath
                - expr: "[JSON.stringify({ type: 'session', id: config.transcriptId, timestamp: new Date(now - 120000).toISOString() }), JSON.stringify({ type: 'message', message: { role: 'user', timestamp: new Date(now - 90000).toISOString(), content: [{ type: 'text', text: config.transcriptQuestion }] } }), JSON.stringify({ type: 'message', message: { role: 'assistant', timestamp: new Date(now - 60000).toISOString(), content: [{ type: 'text', text: config.transcriptAnswer }] } })].join('\\n') + '\\n'"
                - utf8
            - call: readRawQaSessionStore
              saveAs: sessionStore
              args:
                - ref: env
            - set: sessionStorePath
              value:
                expr: "path.join(env.gateway.tempRoot, 'state', 'agents', 'qa', 'sessions', 'sessions.json')"
            - call: fs.writeFile
              args:
                - ref: sessionStorePath
                - expr: "JSON.stringify({ ...sessionStore, ['agent:qa:seed-session-memory-ranking']: { sessionId: config.transcriptId, updatedAt: now, sessionFile: transcriptPath, origin: { label: 'QA seeded session memory ranking transcript' } } }, null, 2)"
                - utf8
            - call: forceMemoryIndex
              args:
                - env:
                    ref: env
                  query:
                    expr: "`current Project Nebula codename ${currentFact}`"
                  expectedNeedle:
                    ref: currentFact
            - call: reset
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey: agent:qa:session-memory-ranking
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
                    expr: "candidate.conversation.id === 'qa-operator' && (candidate.text.includes(currentFact) || candidate.text.includes(staleFact) || /no hits|unknown|not available/i.test(candidate.text))"
                - expr: liveTurnTimeoutMs(env, 45000)
            - assert:
                expr: "outbound.text.includes(currentFact)"
                message:
                  expr: "`expected current transcript-backed fact ${currentFact}, got: ${outbound.text}`"
            - set: lower
              value:
                expr: "normalizeLowercaseStringOrEmpty(outbound.text)"
            - set: staleLeak
              value:
                expr: "outbound.text.includes(staleFact) && !/(stale|durable|conflict|older|previous)/i.test(outbound.text)"
            - assert:
                expr: "!staleLeak"
                message:
                  expr: "`stale durable fact leaked through: ${outbound.text}`"
            - if:
                expr: "Boolean(env.mock)"
                then:
                  - call: fetchJson
                    saveAs: requests
                    args:
                      - expr: "`${env.mock.baseUrl}/debug/requests`"
                  - set: relevant
                    value:
                      expr: "requests.filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet))"
                  - assert:
                      expr: "relevant.some((request) => request.plannedToolName === 'memory_search')"
                      message: expected memory_search in session memory ranking flow
          finally:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    tools:
                      sessions:
                        expr: "originalToolsSessions === undefined ? null : structuredClone(originalToolsSessions)"
                    agents:
                      defaults:
                        memorySearch:
                          expr: "originalMemorySearch === undefined ? null : structuredClone(originalMemorySearch)"
            - call: waitForGatewayHealthy
              args:
                - ref: env
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
    detailsExpr: outbound.text
```
