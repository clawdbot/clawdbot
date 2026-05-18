# Memory recall runtime tool fixture

```yaml qa-scenario
id: runtime-tool-memory-recall
title: Runtime tool fixture — memory.recall
surface: runtime-tools
runtimeParityTier: optional
coverage:
  primary:
    - tools.memory.recall
objective: Verify memory_recall parity when the memory plugin exposes the tool.
successCriteria:
  - If memory_recall is present, the fixture exercises happy and failure paths.
  - If memory_recall is absent, the fixture records the known-broken tracking marker.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - extensions/memory-lancedb/index.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise or track the memory_recall runtime tool family.
  config:
    toolName: memory_recall
    expectedAvailable: false
    toolCoverage:
      family: memory.recall
      actualTool: memory_recall
      bucket: optional-profile-or-plugin
      expectedLayer: profile-or-plugin
      required: false
      tracking: "#80173"
      codexDefaultImpact: P4
      qaImpact: P3
      action: keep optional unless memory plugin coverage is explicitly enabled
      reason: memory_recall is plugin-dependent and absent from some mock QA runs.
    knownBroken:
      issue: "#80173"
      reason: memory_recall is plugin-dependent and absent from the default mock QA run.
    promptSnippet: "target=memory_recall"
    failurePromptSnippet: "failure target=memory_recall"
```

```yaml qa-flow
steps:
  - name: exercises or records memory_recall coverage
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
