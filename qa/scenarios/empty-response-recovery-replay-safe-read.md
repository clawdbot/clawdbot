# Empty-response recovery after replay-safe read

```yaml qa-scenario
id: empty-response-recovery-replay-safe-read
title: Empty-response recovery after replay-safe read
surface: runtime
objective: Verify an empty visible GPT turn after a replay-safe read auto-continues into a visible answer.
successCriteria:
  - Scenario is mock-openai only so live lanes do not pick it up implicitly.
  - The agent performs a replay-safe read before the empty response.
  - The runtime injects the visible-answer continuation instruction after the empty turn.
  - The final visible reply contains the exact recovery marker.
docsRefs:
  - docs/help/testing.md
codeRefs:
  - extensions/qa-lab/src/mock-openai-server.ts
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
execution:
  kind: flow
  summary: Verify empty OpenAI turns recover after a replay-safe read.
  config:
    requiredProvider: mock-openai
    promptSnippet: Empty response continuation QA check
    prompt: "Empty response continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-RECOVERED-OK."
    expectedReply: EMPTY-RECOVERED-OK
    retryNeedle: The previous attempt did not produce a user-visible answer.
```

```yaml qa-flow
steps:
  - name: retries an empty replay-safe read into a visible answer
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
          expr: "`agent:qa:empty-response-recovery:${randomUUID().slice(0, 8)}`"
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
            expr: "`missing empty-response recovery marker: ${outbound.text}`"
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
                message: expected empty-response retry instruction in mock trace
    detailsExpr: "env.mock ? `${outbound.text}\\nrequests=${String(scenarioRequests?.length ?? 0)}` : outbound.text"
```
