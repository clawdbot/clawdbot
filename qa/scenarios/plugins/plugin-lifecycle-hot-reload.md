# Plugin lifecycle hot reload

```yaml qa-scenario
id: plugin-lifecycle-hot-reload
title: Plugin lifecycle hot reload
surface: plugins
coverage:
  primary:
    - plugins.lifecycle
  secondary:
    - plugins.hot-reload
    - config.hot-apply
objective: Verify a runtime-owned capability can be disabled and re-enabled through hot config reload without stale state.
successCriteria:
  - Workspace skill capability is eligible before reload.
  - Hot config disables the capability and status reflects the disabled state.
  - A second hot reload re-enables the capability and the next agent turn can use it.
docsRefs:
  - docs/tools/skills.md
  - docs/gateway/configuration.md
  - docs/plugins/manifest.md
codeRefs:
  - src/agents/skills-status.ts
  - src/gateway/server-methods/config.ts
  - extensions/qa-lab/src/suite-runtime-agent-tools.ts
execution:
  kind: flow
  summary: Disable and re-enable a workspace skill through config.patch and verify the capability is not stale.
  config:
    skillName: qa-lifecycle-hot-reload-skill
    prompt: "Lifecycle hot reload marker. Reply exactly: LIFECYCLE-HOT-RELOAD-OK"
    expectedReply: LIFECYCLE-HOT-RELOAD-OK
    skillBody: |-
      ---
      name: qa-lifecycle-hot-reload-skill
      description: Lifecycle hot reload QA marker
      ---
      When the user asks for the lifecycle marker exactly, reply with exactly: LIFECYCLE-HOT-RELOAD-OK
```

```yaml qa-flow
steps:
  - name: disables and re-enables a runtime capability without stale state
    actions:
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
              expr: "findSkill(await readSkillStatus(env), config.skillName)?.eligible ? true : undefined"
          - 15000
          - 200
      - call: patchConfig
        args:
          - env:
              ref: env
            patch:
              skills:
                entries:
                  expr: "({ [config.skillName]: { enabled: false } })"
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: waitForCondition
        args:
          - lambda:
              async: true
              expr: "findSkill(await readSkillStatus(env), config.skillName)?.disabled ? true : undefined"
          - 15000
          - 200
      - call: patchConfig
        args:
          - env:
              ref: env
            patch:
              skills:
                entries:
                  expr: "({ [config.skillName]: { enabled: true } })"
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: waitForCondition
        args:
          - lambda:
              async: true
              expr: "((skill) => skill?.eligible && !skill?.disabled ? true : undefined)(findSkill(await readSkillStatus(env), config.skillName))"
          - 15000
          - 200
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: "`agent:qa:plugin-lifecycle:${randomUUID().slice(0, 8)}`"
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
              expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.expectedReply)"
          - expr: liveTurnTimeoutMs(env, 20000)
    detailsExpr: outbound.text
```
