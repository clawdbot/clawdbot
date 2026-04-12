# Compaction retry after mutating tool

```yaml qa-scenario
id: compaction-retry-mutating-tool
title: Compaction retry after mutating tool
surface: runtime
objective: Verify a real mutating tool step keeps replay-unsafety explicit instead of disappearing into a clean-looking success if the run compacts or retries.
successCriteria:
  - Agent reads the seeded large context before it writes.
  - Agent performs a real mutating write in the workspace.
  - Final reply explicitly says replay is unsafe after the write instead of implying replay-safe completion.
  - Scenario details preserve the observed compaction count for review context.
docsRefs:
  - docs/help/testing.md
  - docs/help/gpt54-codex-agentic-parity.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
  - src/agents/pi-embedded-subscribe.ts
  - src/agents/pi-embedded-subscribe.handlers.lifecycle.ts
execution:
  kind: flow
  summary: Verify a mutating tool step keeps replay-unsafety explicit through compaction or retry pressure.
  config:
    contextFile: COMPACTION_RETRY_CONTEXT.md
    outputFile: compaction-retry-summary.txt
    promptSnippet: Compaction retry mutating tool check
    replayUnsafeNeedle: replay unsafe after write
    prompt: |-
      Compaction retry mutating tool check: read `COMPACTION_RETRY_CONTEXT.md`, then create `compaction-retry-summary.txt` in the workspace containing exactly this line:
      Replay safety: unsafe after write.

      After the write, reply with one short sentence that includes the exact phrase `replay unsafe after write`.
      If the run gets compacted or retried, keep that replay-safety truth explicit and do not claim the task stayed replay-safe.
```

```yaml qa-flow
steps:
  - name: keeps replay-unsafety explicit after a mutating write under compaction pressure
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - call: fs.writeFile
        args:
          - expr: "path.join(env.gateway.workspaceDir, config.contextFile)"
          - expr: "Array.from({ length: env.providerMode === 'mock-openai' ? 160 : 2200 }, (_, index) => `compaction retry evidence block ${String(index).padStart(4, '0')} :: keep replay truth explicit after side effects`).join('\\n')"
          - utf8
      - set: sessionKey
        value:
          expr: "`agent:qa:compaction-retry:${randomUUID().slice(0, 8)}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              ref: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 90000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && normalizeLowercaseStringOrEmpty(candidate.text).includes(config.replayUnsafeNeedle)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 45000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - call: fs.readFile
        saveAs: writtenSummary
        args:
          - expr: "path.join(env.gateway.workspaceDir, config.outputFile)"
          - utf8
      - assert:
          expr: "writtenSummary.includes('Replay safety: unsafe after write.')"
          message:
            expr: "`summary file missed replay marker: ${writtenSummary}`"
      - if:
          expr: "Boolean(env.mock)"
          then:
            - assert:
                expr: "!env.mock || ([...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))].toReversed().find((request) => String(request.allInputText ?? '').includes(config.promptSnippet) && String(request.toolOutput ?? '').includes('compaction retry evidence block'))?.plannedToolName === 'write')"
                message:
                  expr: "`expected write after seeded context read, got ${String(([...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))].toReversed().find((request) => String(request.allInputText ?? '').includes(config.promptSnippet) && String(request.toolOutput ?? '').includes('compaction retry evidence block'))?.plannedToolName ?? '')}`"
      - call: readRawQaSessionStore
        saveAs: store
        args:
          - ref: env
      - set: sessionEntry
        value:
          expr: "store[sessionKey]"
      - assert:
          expr: "Boolean(sessionEntry)"
          message:
            expr: "`missing QA session entry for ${sessionKey}`"
    detailsExpr: "`${outbound.text}\\ncompactionCount=${String(sessionEntry?.compactionCount ?? 0)}\\nstatus=${String(sessionEntry?.status ?? 'unknown')}`"
```
