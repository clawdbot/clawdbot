# Approval turn tool followthrough

```yaml qa-scenario
id: approval-turn-tool-followthrough
title: Approval turn tool followthrough
surface: harness
coverage:
  primary:
    - runtime.approvals
  secondary:
    - tools.followthrough
objective: Verify a short approval like "ok do it" triggers immediate tool use instead of fake-progress narration.
successCriteria:
  - Agent can keep the pre-action turn brief.
  - The short approval leads to a real tool call on the next turn.
  - Final answer uses tool-derived evidence instead of placeholder progress text.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
execution:
  kind: flow
  summary: Verify a short approval like "ok do it" triggers immediate tool use instead of fake-progress narration.
  config:
    preActionPrompt: Before acting, tell me the single file you would start with in six words or fewer. Do not use tools yet.
    approvalPrompt: ok do it. read `QA_KICKOFF_TASK.md` now and reply with the QA mission in one short sentence.
    expectedReplyAny:
      - qa
      - mission
      - testing
      - repo
      - worked
      - failed
      - blocked
      - chat flows
```

```yaml qa-flow
steps:
  - name: turns short approval into a real file read
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:approval-followthrough
            message:
              expr: config.preActionPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - call: waitForOutboundMessage
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: liveTurnTimeoutMs(env, 60000)
      - set: beforeApprovalCursor
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:approval-followthrough
            message:
              expr: config.approvalPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - set: expectedReplyAny
        value:
          expr: config.expectedReplyAny.map(normalizeLowercaseStringOrEmpty)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(beforeApprovalCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && expectedReplyAny.some((needle) => normalizeLowercaseStringOrEmpty(candidate.text).includes(needle))).at(-1)"
          - expr: liveTurnTimeoutMs(env, 60000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
    detailsExpr: outbound.text
```
