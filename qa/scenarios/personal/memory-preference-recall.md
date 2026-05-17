# Personal memory preference recall

```yaml qa-scenario
id: personal-memory-preference-recall
title: Personal memory preference recall
surface: personal
category: memory
coverage:
  primary:
    - personal.memory-recall
  secondary:
    - memory.recall
    - channels.qa-channel
risk: medium
capabilities:
  - memory.recall
  - channel.reply
objective: Verify a fake personal preference can be remembered and recalled later in the same QA personal conversation.
successCriteria:
  - Agent acknowledges the fake preference without using real user memory.
  - Agent later recalls the same fake preference code.
  - Recall stays scoped to the temporary QA conversation.
docsRefs:
  - docs/concepts/memory.md
  - docs/concepts/memory-search.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-lab/src/suite-runtime-agent.ts
execution:
  kind: flow
  summary: Verify fake personal preference recall through the local QA memory path.
  config:
    sessionKey: agent:qa:personal-memory
    rememberPrompt: "Please remember this fact for later: my fake personal QA preference is that my preferred reminder label code is ORBIT-9. Use your normal memory mechanism and reply exactly `Remembered ORBIT-9.` once stored."
    rememberAckAny:
      - remembered orbit-9
    recallPrompt: "Memory tools check: what fake personal reminder label code did I ask you to remember earlier? Reply with the code only, plus at most one short sentence."
    recallExpectedAny:
      - orbit-9
```

```yaml qa-flow
steps:
  - name: stores the fake personal preference
    actions:
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
          - sessionKey:
              expr: config.sessionKey
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
          - expr: liveTurnTimeoutMs(env, 30000)
    detailsExpr: outbound.text

  - name: recalls the fake personal preference
    actions:
      - set: recallStartIndex
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: config.sessionKey
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
              expr: "state.getSnapshot().messages.slice(recallStartIndex).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && recallExpectedAny.some((needle) => normalizeLowercaseStringOrEmpty(candidate.text).includes(needle))).at(-1)"
          - expr: liveTurnTimeoutMs(env, 30000)
    detailsExpr: outbound.text
```
