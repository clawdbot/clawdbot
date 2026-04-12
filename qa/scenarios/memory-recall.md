# Memory recall after context switch

```yaml qa-scenario
id: memory-recall
title: Memory recall after context switch
surface: memory
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
