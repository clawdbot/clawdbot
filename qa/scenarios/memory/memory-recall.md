# Memory recall after context switch

<!--
  This scenario deliberately stays prose-only and does NOT gate on a
  `/debug/requests` tool-call assertion, even though it is one of the
  scenarios in the parity pack. The adversarial review in the umbrella
  #64227 thread called this out as a coverage gap, but the underlying
  behavior the scenario tests is legitimately prose-shaped: the agent is
  supposed to pull a prior-turn fact ("ALPHA-7") back across an
  intervening context switch and reply with the code. In a real
  conversation, the model can do this EITHER by calling a memory-search
  tool (which the qa-lab mock server doesn't currently expose) OR by
  reading the fact directly from prior-turn context in its own
  conversation window. Both strategies are valid parity behavior.

  Forcing a `plannedToolName` assertion here would either require
  extending the mock with a synthetic `memory_search` tool lane (PR O
  scope, not PR J) or fabricating a tool-call requirement the real
  providers never implement. Either path would make this scenario test
  the harness, not the models. So we keep it prose-only, covered by the
  `recallExpectedAny` / `rememberAckAny` assertions above, and flag the
  exception explicitly rather than silently.

  Criterion 2 of the parity completion gate (no fake progress or fake
  tool completion) is enforced for this scenario through the parity
  report's failure-tone fake-success detector: a scenario marked `pass`
  whose details text matches patterns like "timed out", "failed to",
  "could not" gets flagged via `SUSPICIOUS_PASS_FAILURE_TONE_PATTERNS`
  in `extensions/qa-lab/src/agentic-parity-report.ts`. Positive-tone
  detection was removed because it false-positives on legitimate passes
  where the details field is the model's outbound prose.
-->

```yaml qa-scenario
id: memory-recall
title: Memory recall after context switch
surface: memory
coverage:
  primary:
    - memory.recall
objective: Verify the agent can store a fact, switch topics, then recall the fact accurately later.
successCriteria:
  - Agent acknowledges the seeded fact.
  - Agent later recalls the same fact correctly.
  - Recall stays scoped to the active QA conversation.
docsRefs:
  - docs/help/testing.md
codeRefs:
  - extensions/qa-lab/src/scenario.ts
execution:
  kind: flow
  summary: Verify the agent can store a fact, switch topics, then recall the fact accurately later.
  config:
    resetDurableMemory: true
    rememberPrompt: "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored."
    rememberAckAny:
      - remembered alpha-7
    recallPrompt: "What was the QA canary code I asked you to remember earlier? Reply with the code only, plus at most one short sentence."
    recallExpectedAny:
      - alpha-7
```

```yaml qa-flow
steps:
  - name: stores the canary fact
    actions:
      - assert:
          expr: "!config.resetDurableMemory || true"
      - call: fs.rm
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
          - force: true
      - call: fs.rm
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'memory', `${formatMemoryDreamingDay(Date.now())}.md`)"
          - force: true
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:memory
            message:
              expr: config.rememberPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - set: rememberAckAny
        value:
          expr: config.rememberAckAny.map(normalizeLowercaseStringOrEmpty)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && rememberAckAny.some((needle) => normalizeLowercaseStringOrEmpty(candidate.text).includes(needle))"
    detailsExpr: outbound.text
  - name: recalls the same fact later
    actions:
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:memory
            message:
              expr: config.recallPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - set: recallExpectedAny
        value:
          expr: config.recallExpectedAny.map(normalizeLowercaseStringOrEmpty)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && recallExpectedAny.some((needle) => normalizeLowercaseStringOrEmpty(candidate.text).includes(needle))).at(-1)"
          - 20000
    detailsExpr: outbound.text
```
