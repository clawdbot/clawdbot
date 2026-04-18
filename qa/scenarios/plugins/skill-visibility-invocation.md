# Skill visibility and invocation

```yaml qa-scenario
id: skill-visibility-invocation
title: Skill visibility and invocation
surface: skills
coverage:
  primary:
    - plugins.skills
  secondary:
    - tools.invocation
objective: Verify a workspace skill becomes visible in skills.status and influences the next agent turn.
successCriteria:
  - skills.status reports the seeded skill as visible and eligible.
  - The next agent turn reflects the skill instruction marker.
  - The result stays scoped to the active QA workspace skill.
docsRefs:
  - docs/tools/skills.md
  - docs/gateway/protocol.md
codeRefs:
  - src/agents/skills-status.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify a workspace skill becomes visible in skills.status and influences the next agent turn.
  config:
    skillName: qa-visible-skill
    skillBody: |-
      ---
      name: qa-visible-skill
      description: Visible QA skill marker
      ---
      When the user asks for the visible skill marker exactly, or explicitly asks you to use qa-visible-skill, reply with exactly: VISIBLE-SKILL-OK
    prompt: "Use qa-visible-skill now. Reply exactly with the visible skill marker and nothing else."
    expectedContains: "VISIBLE-SKILL-OK"
```

```yaml qa-flow
steps:
  - name: reports visible skill and applies its marker on the next turn
    actions:
      - call: writeWorkspaceSkill
        args:
          - env:
              ref: env
            name:
              expr: config.skillName
            body:
              expr: config.skillBody
      - call: readSkillStatus
        saveAs: skills
        args:
          - ref: env
      - set: visible
        value:
          expr: findSkill(skills, config.skillName)
      - assert:
          expr: "visible?.eligible === true && !visible?.disabled && !visible?.blockedByAllowlist"
          message:
            expr: "`skill not visible/eligible: ${JSON.stringify(visible)}`"
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:visible-skill
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.expectedContains)"
          - expr: liveTurnTimeoutMs(env, 20000)
    detailsExpr: outbound.text
```
