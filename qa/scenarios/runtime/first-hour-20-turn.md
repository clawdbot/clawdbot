# First-hour 20-turn runtime parity

```yaml qa-scenario
id: runtime-first-hour-20-turn
title: First-hour 20-turn runtime parity
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.first-hour-20
  secondary:
    - runtime.long-context
objective: Verify both runtimes preserve a same-session conversation across the required 20-turn maintainer gate.
successCriteria:
  - The same QA session accepts 20 sequential user turns.
  - Every turn receives the requested marker reply without losing session state.
  - Runtime parity captures wall-clock and token data for the whole 20-turn cell.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/runtime-parity.ts
execution:
  kind: flow
  summary: Run 20 deterministic same-session marker turns through the runtime pair.
  config:
    runtimeParityComparison: outcome-only
    sessionKey: agent:qa:first-hour-20-turn
    turnCount: 20
```

```yaml qa-flow
steps:
  - name: runs 20 same-session marker turns
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - set: turns
        value:
          expr: "Array.from({ length: config.turnCount }, (_entry, index) => ({ index, marker: `FIRST-HOUR-20-${String(index + 1).padStart(2, '0')}` }))"
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
                    expr: "'first-hour 20-turn marker check ' + (turn.index + 1) + ': reply exactly `' + turn.marker + '`'"
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 60000)
            - call: waitForCondition
              args:
                - lambda:
                    expr: "state.getSnapshot().messages.slice(cursor).some((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && normalizeLowercaseStringOrEmpty(candidate.text).includes(normalizeLowercaseStringOrEmpty(turn.marker)))"
                - expr: liveTurnTimeoutMs(env, 60000)
                - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
    detailsExpr: "`completed ${turns.length} first-hour depth turns`"
```
