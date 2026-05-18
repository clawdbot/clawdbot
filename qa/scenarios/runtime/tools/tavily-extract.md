# Tavily extract runtime tool fixture

```yaml qa-scenario
id: runtime-tool-tavily-extract
title: Runtime tool fixture — tavily_extract
surface: runtime-tools
runtimeParityTier: optional
coverage:
  primary:
    - tools.tavily-extract
objective: Track tavily_extract parity once the tool is present in the runtime surface.
successCriteria:
  - If tavily_extract is present, the fixture exercises happy and failure paths.
  - If tavily_extract is absent, the fixture records the known-broken tracking marker.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Track tavily_extract runtime parity coverage.
  config:
    toolName: tavily_extract
    expectedAvailable: false
    toolCoverage:
      family: tavily_extract
      actualTool: tavily_extract
      bucket: optional-profile-or-plugin
      expectedLayer: profile-or-plugin
      required: false
      tracking: "#80173"
      codexDefaultImpact: P4
      qaImpact: P3
      action: keep optional unless Tavily integration is explicitly enabled
      reason: Tavily tools are listed in the phase matrix but are not exposed by the current default tool surface.
    knownBroken:
      issue: "#80173"
      reason: tavily_extract is not exposed by the current default tool surface.
    promptSnippet: "target=tavily_extract"
    failurePromptSnippet: "failure target=tavily_extract"
```

```yaml qa-flow
steps:
  - name: exercises or records tavily_extract coverage
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
