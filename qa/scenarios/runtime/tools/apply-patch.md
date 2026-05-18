# Apply patch runtime tool fixture

```yaml qa-scenario
id: runtime-tool-apply-patch
title: Runtime tool fixture — apply-patch
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.apply-patch
objective: Verify apply_patch behavior is tracked across Pi and Codex while Codex owns patching natively.
successCriteria:
  - Pi may expose OpenClaw apply_patch while Codex app-server mode may omit duplicate OpenClaw dynamic apply_patch.
  - Mock provider apply_patch plans are reported as fixture intent, not as actual runtime tool calls.
  - The row stays report-only until fault injection uses valid patch-shaped inputs.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/apply-patch.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the apply_patch runtime tool family.
  config:
    toolName: apply_patch
    toolCoverage:
      family: apply-patch
      actualTool: apply_patch
      bucket: codex-native-workspace
      expectedLayer: codex-native-workspace
      required: true
      tracking: "#80320"
      codexDefaultImpact: P4
      qaImpact: P2
      action: fix fixture fault injection
      reason: Codex app-server intentionally owns apply_patch natively; this fixture still needs valid patch-shaped fault injection before it can prove product behavior.
    knownHarnessGap:
      issue: "#80320"
      reason: Codex-native apply_patch is intentionally not an OpenClaw dynamic tool; QA fault injection still uses synthetic failure-path inputs.
    promptSnippet: "target=apply_patch"
    failurePromptSnippet: "failure target=apply_patch"
```

```yaml qa-flow
steps:
  - name: exercises apply_patch happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
