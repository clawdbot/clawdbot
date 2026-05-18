# Web fetch runtime tool fixture

```yaml qa-scenario
id: runtime-tool-web-fetch
title: Runtime tool fixture — web_fetch
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.web-fetch
objective: Verify web_fetch preserves arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose web_fetch.
  - The mock provider plans exactly one happy-path web_fetch call.
  - The mock provider plans one denied-input failure-path web_fetch call.
  - Runtime parity coverage hard-fails call/result drift in the standard direct-loading gate.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/web-fetch.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the web_fetch runtime tool family.
  config:
    toolName: web_fetch
    toolCoverage:
      family: web_fetch
      actualTool: web_fetch
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      capabilityLayer: openclaw-dynamic-direct
      required: true
      codexDefaultImpact: P4
      qaImpact: P1
      action: hard gate in the standard direct-loading tier
      reason: web_fetch is an OpenClaw integration tool and must stay visible and callable under Pi and Codex direct runtime parity.
    promptSnippet: "target=web_fetch"
    failurePromptSnippet: "failure target=web_fetch"
```

```yaml qa-flow
steps:
  - name: exercises web_fetch happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
