# 100-turn runtime parity soak

```yaml qa-scenario
id: runtime-soak-100-turn
title: 100-turn runtime parity soak
surface: runtime
runtimeParityTier: soak
coverage:
  primary:
    - runtime.soak-100
  secondary:
    - runtime.long-context
objective: Provide an optional long-run soak that can be scheduled or run in Testbox without entering the maintainer default gate.
successCriteria:
  - The same QA session accepts 100 sequential user turns.
  - Every turn receives the requested marker reply without losing session state.
  - Runtime parity captures token estimate or live token usage for the full soak cell.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/runtime-parity.ts
execution:
  kind: flow
  summary: Run the optional 100-turn same-session runtime soak.
  config:
    sessionKey: agent:qa:runtime-soak-100
    turnCount: 100
```

```yaml qa-flow
steps:
  - name: runs 100 same-session marker turns
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - set: turns
        value:
          expr: "Array.from({ length: config.turnCount }, (_entry, index) => ({ index, marker: `SOAK-100-${String(index + 1).padStart(3, '0')}` }))"
      - forEach:
          items:
            ref: turns
          item: turn
          actions:
            - set: cursor
              value:
                expr: state.getSnapshot().messages.length
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey:
                    expr: config.sessionKey
                  message:
                    expr: "'runtime 100-turn soak marker check ' + (turn.index + 1) + ': reply exactly `' + turn.marker + '`'"
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 60000)
            - call: waitForCondition
              args:
                - lambda:
                    expr: "state.getSnapshot().messages.slice(cursor).some((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && normalizeLowercaseStringOrEmpty(candidate.text).includes(normalizeLowercaseStringOrEmpty(turn.marker)))"
                - expr: liveTurnTimeoutMs(env, 60000)
                - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
    detailsExpr: "`completed ${turns.length} soak turns`"
```
