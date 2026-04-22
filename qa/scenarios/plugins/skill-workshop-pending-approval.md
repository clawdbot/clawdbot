# Skill Workshop pending approval

```yaml qa-scenario
id: skill-workshop-pending-approval
title: Skill Workshop pending approval
surface: plugins
coverage:
  primary:
    - plugins.skill-workshop
  secondary:
    - plugins.plugin-tools
    - plugins.skills
objective: Verify an explicit pending skill suggestion queues for review, then approval writes a workspace skill.
plugins:
  - skill-workshop
gatewayConfigPatch:
  plugins:
    entries:
      skill-workshop:
        enabled: true
        config:
          autoCapture: true
          approvalPolicy: auto
          reviewMode: heuristic
successCriteria:
  - A realistic screenshot asset workflow queues a pending skill suggestion.
  - The skill_workshop tool reports the pending item.
  - Applying the item writes the workspace skill and refreshes skill status.
docsRefs:
  - docs/plugins/skill-workshop.md
  - docs/tools/skills.md
codeRefs:
  - extensions/skill-workshop/src/tool.ts
  - extensions/skill-workshop/src/store.ts
  - extensions/qa-lab/src/suite-runtime-agent-tools.ts
execution:
  kind: flow
  summary: Queue a pending screenshot workflow suggestion and approve it through the plugin tool.
  config:
    skillName: screenshot-asset-workflow
    proposalTitle: Verify screenshot asset replacements before final reply
    proposalReason: User established a repeatable screenshot asset update workflow.
    proposalDescription: Capture the repeatable checklist for app screenshot asset replacements.
    proposalBody: |-
      When updating an app screenshot asset, first identify the newest PNG in Desktop or Downloads if the user has not specified a file.
      Verify the image dimensions against the target asset before replacement.
      Preserve the expected asset size and aspect constraints, optimize the PNG after replacement, and run the relevant validation gate before reporting completion.
```

```yaml qa-flow
steps:
  - name: queues and applies a pending skill update
    actions:
      - call: reset
      - call: callPluginToolsMcp
        saveAs: suggestResult
        args:
          - env:
              ref: env
            toolName: skill_workshop
            args:
              action: suggest
              apply: false
              skillName:
                expr: config.skillName
              title:
                expr: config.proposalTitle
              reason:
                expr: config.proposalReason
              description:
                expr: config.proposalDescription
              body:
                expr: config.proposalBody
      - call: waitForCondition
        saveAs: pendingResult
        args:
          - lambda:
              async: true
              expr: |-
                (async () => {
                  const result = await callPluginToolsMcp({
                    env,
                    toolName: 'skill_workshop',
                    args: { action: 'list_pending' },
                  });
                  const text = JSON.stringify(result);
                  return text.includes(config.skillName) ? result : undefined;
                })()
          - 15000
          - 500
      - set: pendingText
        value:
          expr: "JSON.stringify({ suggestResult, pendingResult })"
      - set: pendingId
        value:
          expr: "JSON.parse(pendingResult.content[0].text)[0].id"
      - call: callPluginToolsMcp
        saveAs: applyResult
        args:
          - env:
              ref: env
            toolName: skill_workshop
            args:
              action: apply
              id:
                ref: pendingId
      - set: skillPath
        value:
          expr: "path.join(env.gateway.workspaceDir, 'skills', config.skillName, 'SKILL.md')"
      - call: waitForCondition
        args:
          - lambda:
              async: true
              expr: "findSkill(await readSkillStatus(env), config.skillName)?.eligible ? true : undefined"
          - 15000
          - 200
      - call: fs.readFile
        saveAs: skillText
        args:
          - ref: skillPath
          - utf8
      - assert:
          expr: "skillText.includes('optimize the PNG') && JSON.stringify(applyResult).includes('applied')"
          message: expected approved skill text and applied result
    detailsExpr: "`PENDING:${pendingText}\\n${skillText}`"
```
