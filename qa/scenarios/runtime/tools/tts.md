# TTS runtime tool fixture

```yaml qa-scenario
id: runtime-tool-tts
title: Runtime tool fixture — tts
surface: runtime-tools
runtimeParityTier: optional
coverage:
  primary:
    - tools.tts
objective: Verify tts preserves arguments and result shape when the tool is present.
successCriteria:
  - If tts is present, the fixture exercises happy and failure paths.
  - If tts is absent, the fixture records the known-broken tracking marker.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/tts-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise or track the tts runtime tool family.
  config:
    toolName: tts
    expectedAvailable: false
    toolCoverage:
      family: tts
      actualTool: tts
      bucket: optional-profile-or-plugin
      expectedLayer: profile-or-plugin
      required: false
      tracking: "#80173"
      codexDefaultImpact: P4
      qaImpact: P3
      action: keep optional unless TTS is explicitly configured
      reason: TTS is configuration-dependent and is not exposed by every mock QA run.
    knownBroken:
      issue: "#80173"
      reason: tts is configuration-dependent and absent from the default mock QA run.
    promptSnippet: "target=tts"
    failurePromptSnippet: "failure target=tts"
```

```yaml qa-flow
steps:
  - name: exercises or records tts coverage
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
