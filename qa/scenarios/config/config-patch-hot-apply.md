# Config patch skill disable

```yaml qa-scenario
id: config-patch-hot-apply
title: Config patch skill disable
surface: config
coverage:
  primary:
    - config.hot-apply
  secondary:
    - plugins.skills
objective: Verify config.patch can disable a workspace skill and the restarted gateway exposes the new disabled state cleanly.
successCriteria:
  - config.patch succeeds for the skill toggle change.
  - A workspace skill works before the patch.
  - The same skill is reported disabled after the restart triggered by the patch.
docsRefs:
  - docs/gateway/configuration.md
  - docs/gateway/protocol.md
codeRefs:
  - src/gateway/server-methods/config.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify config.patch can disable a workspace skill and the restarted gateway exposes the new disabled state cleanly.
  config:
    skillName: qa-hot-disable-skill
    successMarker: HOT-PATCH-DISABLED-OK
    skillBody: |-
      ---
      name: qa-hot-disable-skill
      description: Hot disable QA marker
      ---
      When the user asks for the hot disable marker exactly, reply with exactly: HOT-PATCH-DISABLED-OK
```

```yaml qa-flow
steps:
  - name: disables a workspace skill after config.patch restart
    actions:
      - call: writeWorkspaceSkill
        args:
          - env:
              ref: env
            name:
              expr: config.skillName
            body:
              expr: config.skillBody
      - try:
          actions:
            - call: waitForCondition
              args:
                - lambda:
                    async: true
                    expr: "findSkill(await readSkillStatus(env), config.skillName)?.eligible ? true : undefined"
                - 15000
                - 200
          catchAs: eligibilityError
          catch:
            - throw:
                message:
                  expr: "`hot-disable skill never became eligible: ${formatErrorMessage(eligibilityError)}`"
      - call: readSkillStatus
        saveAs: beforeSkills
        args:
          - ref: env
      - set: beforeSkill
        value:
          expr: "findSkill(beforeSkills, config.skillName)"
      - assert:
          expr: "Boolean(beforeSkill?.eligible) && beforeSkill?.disabled !== true"
          message:
            expr: "`unexpected pre-patch skill state: ${JSON.stringify(beforeSkill)}`"
      - call: patchConfig
        saveAs: patchResult
        args:
          - env:
              ref: env
            patch:
              skills:
                entries:
                  expr: "({ [config.skillName]: { enabled: false } })"
      - try:
          actions:
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
          catchAs: readyError
          catch:
            - throw:
                message:
                  expr: "`qa-channel never returned ready after config.patch: ${formatErrorMessage(readyError)}`"
      - try:
          actions:
            - call: waitForCondition
              args:
                - lambda:
                    async: true
                    expr: "findSkill(await readSkillStatus(env), config.skillName)?.disabled ? true : undefined"
                - 15000
                - 200
          catchAs: disabledError
          catch:
            - throw:
                message:
                  expr: "`hot-disable skill never flipped to disabled: ${formatErrorMessage(disabledError)}`"
      - call: readSkillStatus
        saveAs: afterSkills
        args:
          - ref: env
      - set: afterSkill
        value:
          expr: "findSkill(afterSkills, config.skillName)"
      - assert:
          expr: "Boolean(afterSkill?.disabled)"
          message:
            expr: "`unexpected post-patch skill state: ${JSON.stringify(afterSkill)}`"
    detailsExpr: " `restartDelayMs=${String(patchResult.restart?.delayMs ?? '')}\\nmarker=${config.successMarker}\\npre=${JSON.stringify(beforeSkill)}\\npost=${JSON.stringify(afterSkill)}` "
```
