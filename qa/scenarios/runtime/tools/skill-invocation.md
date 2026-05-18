# Skill invocation runtime tool fixture

```yaml qa-scenario
id: runtime-tool-skill-invocation
title: Runtime tool fixture — skill invocation
surface: runtime-tools
runtimeParityTier: optional
coverage:
  primary:
    - tools.skill-invocation
objective: Track skill invocation parity once skill tools are represented as first-class runtime tools.
successCriteria:
  - If skill_invoke is present, the fixture exercises happy and failure paths.
  - If skill_invoke is absent, the fixture records the known-broken tracking marker.
docsRefs:
  - docs/tools/skills.md
codeRefs:
  - src/agents/skills-clawhub.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Track first-class skill invocation runtime parity coverage.
  config:
    toolName: skill_invoke
    expectedAvailable: false
    toolCoverage:
      family: skill-invocation
      actualTool: skill_invoke
      bucket: optional-profile-or-plugin
      expectedLayer: profile-or-plugin
      required: false
      tracking: "#80173"
      codexDefaultImpact: P4
      qaImpact: P3
      action: keep optional until stable skill_invoke tool semantics exist
      reason: Skills are currently prompt/inventory-driven in QA, not exposed as a stable skill_invoke tool.
    knownBroken:
      issue: "#80173"
      reason: skill_invoke is not exposed by the current default tool surface.
    promptSnippet: "target=skill_invoke"
    failurePromptSnippet: "failure target=skill_invoke"
```

```yaml qa-flow
steps:
  - name: exercises or records skill invocation coverage
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
