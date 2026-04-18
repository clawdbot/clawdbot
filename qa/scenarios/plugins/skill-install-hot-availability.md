# Skill install hot availability

```yaml qa-scenario
id: skill-install-hot-availability
title: Skill install hot availability
surface: skills
coverage:
  primary:
    - plugins.skills
  secondary:
    - plugins.hot-install
objective: Verify a newly added workspace skill shows up without a broken intermediate state and can influence the next turn immediately.
successCriteria:
  - Skill is absent before install.
  - skills.status reports it after install without a restart.
  - The next agent turn reflects the new skill marker.
docsRefs:
  - docs/tools/skills.md
  - docs/gateway/configuration.md
codeRefs:
  - src/agents/skills-status.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify a newly added workspace skill shows up without a broken intermediate state and can influence the next turn immediately.
  config:
    skillName: qa-hot-install-skill
    skillBody: |-
      ---
      name: qa-hot-install-skill
      description: Hot install QA marker
      ---
      When the user asks for the hot install marker exactly, reply with exactly: HOT-INSTALL-OK
    prompt: "Hot install marker: give me the hot install marker exactly."
    expectedContains: "HOT-INSTALL-OK"
```

```yaml qa-flow
steps:
  - name: picks up a newly added workspace skill without restart
    actions:
      - call: readSkillStatus
        saveAs: before
        args:
          - ref: env
      - assert:
          expr: "!findSkill(before, config.skillName)"
          message:
            expr: "`${config.skillName} unexpectedly already present`"
      - call: writeWorkspaceSkill
        args:
          - env:
              ref: env
            name:
              expr: config.skillName
            body:
              expr: config.skillBody
      - call: waitForCondition
        args:
          - lambda:
              async: true
              expr: "((await readSkillStatus(env)).find((skill) => skill.name === config.skillName)?.eligible ? true : undefined)"
          - 15000
          - 200
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:hot-skill
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
