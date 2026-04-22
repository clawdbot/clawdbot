# Skill Workshop reviewer autonomous capture

```yaml qa-scenario
id: skill-workshop-reviewer-autonomous
title: Skill Workshop reviewer autonomous capture
surface: plugins
coverage:
  primary:
    - plugins.skill-workshop
  secondary:
    - plugins.skills
    - plugins.plugin-tools
objective: Verify threshold review can turn a non-trivial workflow into a workspace skill without an explicit correction phrase.
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
          reviewMode: llm
          reviewInterval: 1
          reviewMinToolCalls: 1
successCriteria:
  - The task asks for a reusable animated-media QA workflow without saying "next time" or "remember".
  - The reviewer creates or updates a workspace skill automatically.
  - The skill becomes visible through skills.status without restarting the gateway.
docsRefs:
  - docs/plugins/skill-workshop.md
  - docs/tools/skills.md
codeRefs:
  - extensions/skill-workshop/index.ts
  - extensions/skill-workshop/src/reviewer.ts
  - extensions/skill-workshop/src/workshop.ts
execution:
  kind: flow
  summary: Trigger the LLM reviewer after one successful turn and verify it persists a reusable animated-media workflow.
  config:
    prompt: |-
      Build a compact QA checklist for accepting an externally sourced animated GIF asset in a product UI.

      Include checks for true animation, dimensions, attribution, local copy policy, and a final verification step. Treat this as a workflow we will reuse on similar media tasks.
```

```yaml qa-flow
steps:
  - name: reviewer creates a reusable skill
    actions:
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:skill-workshop-reviewer
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 90000)
      - call: waitForCondition
        saveAs: skillText
        args:
          - lambda:
              async: true
              expr: |-
                (async () => {
                  const root = path.join(env.gateway.workspaceDir, 'skills');
                  const names = await fs.readdir(root).catch(() => []);
                  for (const name of names.toSorted()) {
                    const text = await fs.readFile(path.join(root, name, 'SKILL.md'), 'utf8').catch(() => '');
                    if (text.includes('attribution') && text.toLowerCase().includes('animated')) {
                      return text;
                    }
                  }
                  return undefined;
                })()
          - 30000
          - 500
      - call: waitForCondition
        args:
          - lambda:
              async: true
              expr: |-
                (await readSkillStatus(env)).some((skill) => {
                  const haystack = `${skill.name ?? ''} ${skill.description ?? ''}`.toLowerCase();
                  return skill.eligible && (haystack.includes('gif') || haystack.includes('animated'));
                }) ? true : undefined
          - 15000
          - 200
    detailsExpr: skillText
```
