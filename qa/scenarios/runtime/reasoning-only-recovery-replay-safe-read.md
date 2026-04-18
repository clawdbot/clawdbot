# Reasoning-only recovery after replay-safe read

```yaml qa-scenario
id: reasoning-only-recovery-replay-safe-read
title: Reasoning-only recovery after replay-safe read
surface: runtime
coverage:
  primary:
    - runtime.reasoning-only-recovery
  secondary:
    - runtime.retry-policy
objective: Verify a GPT-style reasoning-only turn after a replay-safe read auto-continues into a visible answer.
successCriteria:
  - Scenario is mock-openai only so live lanes do not pick it up implicitly.
  - The agent performs a replay-safe read before the reasoning-only turn.
  - The runtime injects the visible-answer continuation instruction after the reasoning-only turn.
  - The final visible reply contains the exact recovery marker.
docsRefs:
  - docs/help/testing.md
codeRefs:
  - extensions/qa-lab/src/mock-openai-server.ts
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
execution:
  kind: flow
  summary: Verify reasoning-only OpenAI turns recover after a replay-safe read.
  config:
    requiredProvider: mock-openai
    promptSnippet: Reasoning-only continuation QA check
    prompt: "Reasoning-only continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly REASONING-RECOVERED-OK."
    expectedReply: REASONING-RECOVERED-OK
    retryNeedle: recorded reasoning but did not produce a user-visible answer
```

```yaml qa-flow
steps:
  - name: retries a replay-safe read into a visible answer
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
          expr: "`agent:qa:reasoning-only-recovery:${randomUUID().slice(0, 8)}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
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
              expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.expectedReply)"
          - expr: liveTurnTimeoutMs(env, 30000)
      - assert:
          expr: "outbound.text.includes(config.expectedReply)"
          message:
            expr: "`missing recovery marker: ${outbound.text}`"
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
                expr: "scenarioRequests.some((request) => String(request.allInputText ?? '').includes(config.retryNeedle))"
                message: expected reasoning-only retry instruction in mock trace
    detailsExpr: "env.mock ? `${outbound.text}\\nrequests=${String(scenarioRequests?.length ?? 0)}` : outbound.text"
```
