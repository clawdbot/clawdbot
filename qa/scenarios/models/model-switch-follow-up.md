# Model switch follow-up

```yaml qa-scenario
id: model-switch-follow-up
title: Model switch follow-up
surface: models
coverage:
  primary:
    - models.switching
  secondary:
    - runtime.session-continuity
objective: Verify the agent can switch to a different configured model and continue coherently.
successCriteria:
  - Agent reflects the model switch request.
  - Follow-up answer remains coherent with prior context.
  - Final report notes whether the switch actually happened.
docsRefs:
  - docs/help/testing.md
  - docs/web/dashboard.md
codeRefs:
  - extensions/qa-lab/src/report.ts
execution:
  kind: flow
  summary: Verify the agent can switch to a different configured model and continue coherently.
  config:
    initialPrompt: "Say hello from the default configured model."
    followupPrompt: "Continue the exchange after switching models and note the handoff."
```

```yaml qa-flow
steps:
  - name: runs on the default configured model
    actions:
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:model-switch
            message:
              expr: config.initialPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
    detailsExpr: "env.mock ? String((await fetchJson(`${env.mock.baseUrl}/debug/last-request`))?.body?.model ?? '') : outbound.text"
  - name: switches to the alternate model and continues
    actions:
      - set: alternate
        value:
          expr: splitModelRef(env.alternateModel)
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:model-switch
            message:
              expr: config.followupPrompt
            provider:
              expr: alternate?.provider
            model:
              expr: alternate?.model
            timeoutMs:
              expr: resolveQaLiveTurnTimeoutMs(env, 30000, env.alternateModel)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && (() => { const lower = normalizeLowercaseStringOrEmpty(candidate.text); return lower.includes('switch') || lower.includes('handoff'); })()).at(-1)"
          - expr: resolveQaLiveTurnTimeoutMs(env, 20000, env.alternateModel)
      - assert:
          expr: "!env.mock || ((await fetchJson(`${env.mock.baseUrl}/debug/last-request`))?.body?.model === 'gpt-5.5-alt')"
          message:
            expr: "`expected gpt-5.5-alt, got ${String((await fetchJson(`${env.mock.baseUrl}/debug/last-request`))?.body?.model ?? '')}`"
    detailsExpr: outbound.text
```
