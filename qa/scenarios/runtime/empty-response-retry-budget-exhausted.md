# Empty-response retry budget exhausted

```yaml qa-scenario
id: empty-response-retry-budget-exhausted
title: Empty-response retry budget exhausted
surface: runtime
coverage:
  primary:
    - runtime.empty-response-recovery
  secondary:
    - runtime.retry-policy
objective: Verify repeated empty GPT turns exhaust the retry budget after one continuation attempt.
successCriteria:
  - Scenario is mock-openai only so live lanes do not pick it up implicitly.
  - The agent performs the replay-safe read that makes retrying allowed.
  - Mock trace shows the run reaches a terminal post-read turn without ever producing the requested success marker.
docsRefs:
  - docs/help/testing.md
codeRefs:
  - extensions/qa-lab/src/mock-openai-server.ts
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
execution:
  kind: flow
  summary: Verify empty-response retry exhaustion still surfaces a visible failure.
  config:
    requiredProvider: mock-openai
    promptSnippet: Empty response exhaustion QA check
    prompt: "Empty response exhaustion QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-EXHAUSTED-OK."
    retryNeedle: The previous attempt did not produce a user-visible answer.
```

```yaml qa-flow
steps:
  - name: surfaces a retry error after empty-response exhaustion
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
          expr: "`agent:qa:empty-response-exhausted:${randomUUID().slice(0, 8)}`"
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
      - if:
          expr: "Boolean(env.mock)"
          then:
            - set: scenarioRequests
              value:
                expr: "(await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore)"
            - assert:
                expr: "scenarioRequests.some((request) => String(request.allInputText ?? '').includes(config.promptSnippet) && request.plannedToolName === 'read')"
                message: expected replay-safe read request in mock trace
            - assert:
                expr: "scenarioRequests.length >= 2"
                message: expected at least the replay-safe read request and one terminal post-read turn
    detailsExpr: "env.mock ? `requests=${String(scenarioRequests?.length ?? 0)}` : String(waited?.status ?? '')"
```
