# Memory add runtime tool fixture

```yaml qa-scenario
id: runtime-tool-memory-add
title: Runtime tool fixture — memory.add
surface: runtime-tools
runtimeParityTier: optional
coverage:
  primary:
    - tools.memory.add
objective: Track memory.add parity once a first-class memory add tool is exposed.
successCriteria:
  - If memory_add is present, the fixture exercises happy and failure paths.
  - If memory_add is absent, the fixture records the known-broken tracking marker.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - extensions/memory-lancedb/index.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Track memory.add runtime parity coverage.
  config:
    toolName: memory_add
    expectedAvailable: false
    toolCoverage:
      family: memory.add
      actualTool: memory_add
      bucket: optional-profile-or-plugin
      expectedLayer: profile-or-plugin
      required: false
      tracking: "#80173"
      codexDefaultImpact: P4
      qaImpact: P3
      action: keep optional until memory_add exists in the configured default surface
      reason: The phase matrix includes memory.add, but the current plugin surface exposes recall/search contracts instead.
    knownBroken:
      issue: "#80173"
      reason: memory_add is not exposed by the current default tool surface.
    promptSnippet: "target=memory_add"
    failurePromptSnippet: "failure target=memory_add"
```

```yaml qa-flow
steps:
  - name: exercises or records memory.add coverage
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
