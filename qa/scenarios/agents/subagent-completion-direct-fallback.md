# Subagent completion direct fallback

```yaml qa-scenario
id: subagent-completion-direct-fallback
title: Subagent completion direct fallback
surface: subagents
coverage:
  primary:
    - agents.subagents
  secondary:
    - runtime.delivery
    - channels.qa-channel
objective: Verify a yielded parent still receives a successful subagent result through direct fallback delivery when the dormant announce turn produces no visible reply.
successCriteria:
  - Parent launches a native subagent.
  - Parent yields instead of waiting in-turn.
  - Subagent completion result is delivered to the original QA DM without a thread id.
  - Durable task delivery is marked delivered, not failed.
docsRefs:
  - docs/tools/subagents.md
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - src/agents/subagent-announce-delivery.ts
  - src/agents/subagent-registry-lifecycle.ts
  - src/agents/tools/sessions-yield-tool.ts
  - extensions/qa-lab/src/providers/mock-openai/server.ts
execution:
  kind: flow
  summary: Reproduce yielded-parent subagent completion delivery and require frozen-result fallback to the QA DM.
  config:
    prompt: "Subagent direct fallback QA check: spawn one native subagent worker. The worker must finish with exactly QA-SUBAGENT-DIRECT-FALLBACK-OK. After spawning it, call sessions_yield and wait for the completion event. Do not use ACP."
    expectedMarker: QA-SUBAGENT-DIRECT-FALLBACK-OK
    expectedLabel: qa-direct-fallback-worker
```

```yaml qa-flow
steps:
  - name: yielded parent receives child completion through direct fallback
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 120000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 120000
      - call: reset
      - set: sessionKey
        value:
          expr: "`agent:qa:subagent-direct-fallback:${randomUUID().slice(0, 8)}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 90000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound' && String(message.text ?? '').includes(config.expectedMarker)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 60000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "String(outbound.text ?? '').trim().includes(config.expectedMarker)"
          message:
            expr: "`fallback completion marker missing from outbound QA DM: ${recentOutboundSummary(state)}`"
      - if:
          expr: "Boolean(env.mock)"
          then:
            - set: fallbackDebugRequests
              value:
                expr: "[...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))]"
            - assert:
                expr: "fallbackDebugRequests.some((request) => !request.toolOutput && /subagent direct fallback qa check/i.test(String(request.allInputText ?? '')) && request.plannedToolName === 'sessions_spawn' && request.plannedToolArgs?.label === config.expectedLabel)"
                message:
                  expr: "`expected sessions_spawn for yielded fallback scenario, saw ${JSON.stringify(fallbackDebugRequests.map((request) => ({ plannedToolName: request.plannedToolName ?? null, plannedToolArgs: request.plannedToolArgs ?? null })))}`"
            - assert:
                expr: "fallbackDebugRequests.some((request) => /subagent direct fallback qa check/i.test(String(request.allInputText ?? '')) && request.plannedToolName === 'sessions_yield')"
                message:
                  expr: "`expected sessions_yield for yielded fallback scenario, saw ${JSON.stringify(fallbackDebugRequests.map((request) => request.plannedToolName ?? null))}`"
            - call: waitForCondition
              saveAs: deliveredTask
              args:
                - lambda:
                    expr: "(async () => { const payload = await runQaCli(env, ['tasks', 'list', '--json', '--runtime', 'subagent'], { timeoutMs: liveTurnTimeoutMs(env, 60000), json: true }); return (payload.tasks ?? []).find((task) => task.label === config.expectedLabel && task.deliveryStatus === 'delivered' && task.status === 'succeeded') ?? null; })()"
                - expr: liveTurnTimeoutMs(env, 30000)
                - 250
            - assert:
                expr: "deliveredTask.deliveryStatus === 'delivered'"
                message:
                  expr: "`expected delivered task status for ${config.expectedLabel}, got ${JSON.stringify(deliveredTask)}`"
    detailsExpr: "outbound.text"
```
