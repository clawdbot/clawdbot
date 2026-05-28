# Image generation runtime tool fixture

```yaml qa-scenario
id: runtime-tool-image-generate
title: Runtime tool fixture — image_generate
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.image-generate
objective: Verify image_generate preserves arguments and result shape across OpenClaw and Codex.
successCriteria:
  - Effective tools expose image_generate after QA image-generation config is applied.
  - The mock provider plans exactly one happy-path image_generate call.
  - The mock provider plans one denied-input failure-path image_generate call.
  - Runtime parity coverage hard-fails call/result drift in the standard direct-loading gate.
docsRefs:
  - docs/tools/image-generation.md
codeRefs:
  - src/agents/tools/image-generate-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the image_generate runtime tool family.
  config:
    toolName: image_generate
    ensureImageGeneration: true
    toolCoverage:
      family: image_generate
      actualTool: image_generate
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      capabilityLayer: openclaw-dynamic-direct
      required: true
      codexDefaultImpact: P4
      qaImpact: P1
      action: hard gate in the standard direct-loading tier
      reason: image_generate is an OpenClaw integration tool and must stay visible and callable under OpenClaw and Codex direct runtime parity.
    promptSnippet: "target=image_generate"
    failurePromptSnippet: "failure target=image_generate"
```

```yaml qa-flow
steps:
  - name: exercises image_generate happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
