# Web search runtime tool fixture

```yaml qa-scenario
id: runtime-tool-web-search
title: Runtime tool fixture — web_search
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.web-search
objective: Verify web_search preserves arguments and result shape across OpenClaw and Codex.
successCriteria:
  - Effective tools expose web_search.
  - The mock provider plans exactly one happy-path web_search call.
  - The mock provider plans one denied-input failure-path web_search call.
  - Runtime parity coverage hard-fails call/result drift in the standard direct-loading gate.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/web-search.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the web_search runtime tool family.
  config:
    toolName: web_search
    toolCoverage:
      family: web_search
      actualTool: web_search
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      capabilityLayer: openclaw-dynamic-direct
      required: true
      codexDefaultImpact: P4
      qaImpact: P1
      action: hard gate in the standard direct-loading tier
      reason: web_search is an OpenClaw integration tool and must stay visible and callable under OpenClaw and Codex direct runtime parity.
    promptSnippet: "target=web_search"
    failurePromptSnippet: "failure target=web_search"
```

```yaml qa-flow
steps:
  - name: exercises web_search happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
