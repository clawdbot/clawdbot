# Reasoning-only no-auto-retry after write

```yaml qa-scenario
id: reasoning-only-no-auto-retry-after-write
title: Reasoning-only no-auto-retry after write
surface: runtime
objective: Verify a GPT-style reasoning-only turn after a mutating write stays replay-unsafe and does not auto-retry.
successCriteria:
  - Scenario is mock-openai only so live lanes do not pick it up implicitly.
  - The agent performs the seeded mutating write.
  - Mock trace does not include an automatic reasoning-only retry instruction.
  - Mock trace stops after the write-side reasoning-only terminal turn instead of attempting a continuation.
docsRefs:
  - docs/help/testing.md
  - docs/help/gpt54-codex-agentic-parity.md
codeRefs:
  - extensions/qa-lab/src/mock-openai-server.ts
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
execution:
  kind: flow
  summary: Verify reasoning-only turns after a write do not auto-retry.
  config:
    requiredProvider: mock-openai
    promptSnippet: Reasoning-only after write safety check
    prompt: "Reasoning-only after write safety check: write reasoning-only-side-effect.txt, then answer with exactly SIDE-EFFECT-GUARD-OK."
    retryNeedle: recorded reasoning but did not produce a user-visible answer
    outputFile: reasoning-only-side-effect.txt
```

```yaml qa-flow
steps:
  - name: keeps replay-unsafety explicit after a mutating write
    actions:
      - assert:
          expr: "env.providerMode === 'mock-openai'"
          message: this seeded scenario is mock-openai only
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - set: requestCountBefore
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).length : 0"
      - set: sessionKey
        value:
          expr: "`agent:qa:reasoning-only-write:${randomUUID().slice(0, 8)}`"
      - call: startAgentRun
        saveAs: started
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - set: waited
        value:
          expr: "await env.gateway.call('agent.wait', { runId: started.runId, timeoutMs: liveTurnTimeoutMs(env, 45000) }, { timeoutMs: liveTurnTimeoutMs(env, 50000) })"
      - assert:
          expr: "waited?.status === 'ok'"
          message:
            expr: "`agent.wait returned ${String(waited?.status ?? 'unknown')}: ${String(waited?.error ?? '')}`"
      - call: fs.readFile
        saveAs: sideEffect
        args:
          - expr: "path.join(env.gateway.workspaceDir, config.outputFile)"
          - utf8
      - assert:
          expr: "sideEffect.includes('side effects already happened')"
          message:
            expr: "`side-effect file missing expected contents: ${sideEffect}`"
      - if:
          expr: "Boolean(env.mock)"
          then:
            - set: scenarioRequests
              value:
                expr: "(await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore)"
            - assert:
                expr: "scenarioRequests.some((request) => String(request.allInputText ?? '').includes(config.promptSnippet) && request.plannedToolName === 'write')"
                message: expected mutating write request in mock trace
            - assert:
                expr: "!scenarioRequests.some((request) => String(request.allInputText ?? '').includes(config.retryNeedle))"
                message: reasoning-only retry instruction should not be injected after a write
            - assert:
                expr: "scenarioRequests.filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)).length === 2"
                message: expected exactly the write request plus the reasoning-only terminal request
    detailsExpr: "env.mock ? `requests=${String(scenarioRequests?.length ?? 0)} sideEffect=${sideEffect.trim()}` : sideEffect"
```
