# Sessions spawn runtime tool fixture

```yaml qa-scenario
id: runtime-tool-sessions-spawn
title: Runtime tool fixture — sessions_spawn
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.sessions-spawn
objective: Verify sessions_spawn preserves arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose sessions_spawn.
  - The mock provider plans exactly one happy-path sessions_spawn call.
  - The mock provider plans one denied-input failure-path sessions_spawn call.
  - Runtime parity coverage hard-fails call/result drift in the standard direct-loading gate.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/sessions-spawn-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the sessions_spawn runtime tool family.
  config:
    toolName: sessions_spawn
    toolCoverage:
      family: sessions_spawn
      actualTool: sessions_spawn
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      capabilityLayer: openclaw-dynamic-direct
      required: true
      codexDefaultImpact: P4
      qaImpact: P1
      action: hard gate in the standard direct-loading tier
      reason: sessions_spawn is an OpenClaw integration tool and must stay visible and callable under Pi and Codex direct runtime parity.
    promptSnippet: "target=sessions_spawn"
    failurePromptSnippet: "failure target=sessions_spawn"
```

```yaml qa-flow
steps:
  - name: exercises sessions_spawn happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
