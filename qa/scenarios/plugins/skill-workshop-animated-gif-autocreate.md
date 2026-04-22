# Skill Workshop animated GIF autocreate

```yaml qa-scenario
id: skill-workshop-animated-gif-autocreate
title: Skill Workshop animated GIF autocreate
surface: plugins
coverage:
  primary:
    - plugins.skill-workshop
  secondary:
    - plugins.skills
    - skills.hot-refresh
objective: Verify a non-trivial animated GIF correction is captured as a workspace skill and becomes visible without restart.
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
  - The model receives a realistic animated GIF task plus a durable correction.
  - Skill Workshop writes an animated GIF workflow skill automatically.
  - The new skill appears in skills.status without restarting the gateway.
docsRefs:
  - docs/plugins/skill-workshop.md
  - docs/tools/skills.md
codeRefs:
  - extensions/skill-workshop/index.ts
  - extensions/skill-workshop/src/signals.ts
  - extensions/skill-workshop/src/skills.ts
execution:
  kind: flow
  summary: Ask for an animated GIF workflow correction and verify Skill Workshop creates a hot workspace skill.
  config:
    prompt: |-
      Find two sources for small animated loading GIFs and summarize what should be checked before using one.

      Next time when asked for animated GIFs, verify the URL really resolves to an animated GIF, record attribution, and avoid hotlinking when a local asset is needed.
```

```yaml qa-flow
steps:
  - name: creates an animated GIF skill from a durable correction
    actions:
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:skill-workshop-gif
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForCondition
        saveAs: skillText
        args:
          - lambda:
              async: true
              expr: |-
                await (async () => {
                  const root = path.join(env.gateway.workspaceDir, 'skills');
                  const names = await fs.readdir(root).catch(() => []);
                  for (const name of names.toSorted()) {
                    const text = await fs.readFile(path.join(root, name, 'SKILL.md'), 'utf8').catch(() => '');
                    if (text.includes('record attribution') && text.toLowerCase().includes('animated')) {
                      return text;
                    }
                  }
                  return undefined;
                })()
          - 15000
          - 200
      - call: waitForCondition
        args:
          - lambda:
              async: true
              expr: |-
                (await readSkillStatus(env)).some((skill) => {
                  const haystack = `${skill.name ?? ''} ${skill.description ?? ''}`.toLowerCase();
                  return skill.eligible && haystack.includes('gif');
                }) ? true : undefined
          - 15000
          - 200
    detailsExpr: skillText
```
