# Active Memory pre-reply recall

```yaml qa-scenario
id: active-memory-preprompt-recall
title: Active Memory pre-reply recall
surface: memory
objective: Verify Active Memory surfaces a memory-only preference before the main reply, and that the same question stays unresolved when the plugin is off.
plugins:
  - active-memory
gatewayConfigPatch:
  plugins:
    entries:
      active-memory:
        enabled: true
        config:
          enabled: true
          agents:
            - qa
          allowedChatTypes:
            - direct
          logging: true
          persistTranscripts: true
          transcriptDir: qa-memory-e2e
          queryMode: recent
          maxSummaryChars: 220
successCriteria:
  - With Active Memory off, the session shows no Active Memory plugin activity.
  - With Active Memory on, plugin-owned evidence shows the Active Memory sub-agent searched memory before the main reply.
  - Live lane proves the first user-visible reply uses the recalled preference.
docsRefs:
  - docs/concepts/active-memory.md
  - docs/concepts/memory-search.md
codeRefs:
  - extensions/active-memory/index.ts
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: flow
  summary: Verify Active Memory stays off when session-toggled off, runs memory search/get when enabled, and helps a live model answer with the recalled preference in the first visible reply.
  config:
    baselineConversationId: qa-active-memory-off
    activeConversationId: qa-active-memory-on
    memoryFact: "Stable QA movie night snack preference: lemon pepper wings with blue cheese."
    memoryQuery: "QA movie night snack lemon pepper wings blue cheese"
    expectedNeedle: lemon pepper wings
    prompt: "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence."
    promptSnippet: "Silent snack recall check"
    transcriptDir: qa-memory-e2e
```

```yaml qa-flow
steps:
  - name: only active memory surfaces the hidden snack preference
    actions:
      - call: reset
      - call: fs.rm
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
          - force: true
      - call: fs.rm
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'memory', `${formatMemoryDreamingDay(Date.now())}.md`)"
          - force: true
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
      - set: baselineSessionKey
        value:
          expr: "'agent:qa:qa-channel:direct:active-memory-off'"
      - set: activeSessionKey
        value:
          expr: "'agent:qa:qa-channel:direct:active-memory-on'"
      - set: transcriptRoot
        value:
          expr: "path.join(env.gateway.tempRoot, 'state', 'plugins', 'active-memory', 'transcripts', 'agents', 'qa', config.transcriptDir)"
      - set: toggleStorePath
        value:
          expr: "path.join(env.gateway.tempRoot, 'state', 'plugins', 'active-memory', 'session-toggles.json')"
      - call: fs.rm
        args:
          - ref: transcriptRoot
          - recursive: true
            force: true
      - call: fs.rm
        args:
          - ref: toggleStorePath
          - force: true
      - call: fs.mkdir
        args:
          - expr: "path.dirname(toggleStorePath)"
          - recursive: true
      - call: fs.writeFile
        args:
          - ref: toggleStorePath
          - expr: "`${JSON.stringify({ sessions: { [baselineSessionKey]: { disabled: true, updatedAt: Date.now() } } }, null, 2)}\\n`"
          - utf8
      - set: requestCountBeforeBaseline
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).length : 0"
      - set: baselineStartIndex
        value:
          expr: "state.getSnapshot().messages.length"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: baselineSessionKey
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: baselineOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: liveTurnTimeoutMs(env, 30000)
          - sinceIndex:
              ref: baselineStartIndex
      - set: baselineLower
        value:
          expr: "normalizeLowercaseStringOrEmpty(baselineOutbound.text)"
      - if:
          expr: "Boolean(env.mock)"
          then:
            - set: baselineMockRequests
              value:
                expr: "(await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBeforeBaseline)"
      - set: baselineSessionStore
        value:
          expr: "await readRawQaSessionStore(env)"
      - assert:
          expr: "!Array.isArray(baselineSessionStore[baselineSessionKey]?.pluginDebugEntries) || !baselineSessionStore[baselineSessionKey].pluginDebugEntries.some((pluginEntry) => pluginEntry?.pluginId === 'active-memory')"
          message: baseline session unexpectedly recorded active-memory plugin activity
      - set: requestCountBeforeActive
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).length : 0"
      - call: fs.writeFile
        args:
          - ref: toggleStorePath
          - expr: "'{}\\n'"
          - utf8
      - set: activeStartIndex
        value:
          expr: "state.getSnapshot().messages.length"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: activeSessionKey
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: activeOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: liveTurnTimeoutMs(env, 30000)
          - sinceIndex:
              ref: activeStartIndex
      - set: activeLower
        value:
          expr: "normalizeLowercaseStringOrEmpty(activeOutbound.text)"
      - if:
          expr: "!env.mock"
          then:
            - assert:
                expr: "activeLower.includes(normalizeLowercaseStringOrEmpty(config.expectedNeedle))"
                message:
                  expr: "`active memory reply missed the hidden preference: ${activeOutbound.text}`"
      - call: waitForCondition
        saveAs: transcriptPath
        args:
          - lambda:
              async: true
              expr: "await (async () => { const entries = (await fs.readdir(transcriptRoot).catch(() => [])).filter((entry) => entry.endsWith('.jsonl')).toSorted(); return entries.length > 0 ? path.join(transcriptRoot, entries.at(-1)) : undefined; })()"
          - 10000
      - call: fs.readFile
        saveAs: transcriptText
        args:
          - ref: transcriptPath
          - utf8
      - assert:
          expr: "transcriptText.includes('memory_search')"
          message: active memory transcript missing memory_search
      - assert:
          expr: "transcriptText.includes('memory_get')"
          message: active memory transcript missing memory_get
      - call: waitForCondition
        saveAs: activeSessionEntry
        args:
          - lambda:
              async: true
              expr: "await (async () => { const store = await readRawQaSessionStore(env); const entry = store[activeSessionKey]; if (!entry || !Array.isArray(entry.pluginDebugEntries)) return undefined; return entry.pluginDebugEntries.some((pluginEntry) => pluginEntry?.pluginId === 'active-memory' && Array.isArray(pluginEntry.lines) && pluginEntry.lines.some((line) => line.includes('Active Memory: ok'))) ? entry : undefined; })()"
          - 10000
      - if:
          expr: "Boolean(env.mock)"
          then:
            - set: mockRequests
              value:
                expr: "(await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBeforeActive)"
            - assert:
                expr: "mockRequests.some((request) => request.allInputText.includes('You are a memory search agent.') && request.plannedToolName === 'memory_search')"
                message: expected mock Active Memory search request
            - assert:
                expr: "mockRequests.some((request) => request.allInputText.includes('You are a memory search agent.') && request.plannedToolName === 'memory_get')"
                message: expected mock Active Memory memory_get request
    detailsExpr: "`${activeOutbound.text}\\n\\ntranscript=${transcriptPath}`"
```
