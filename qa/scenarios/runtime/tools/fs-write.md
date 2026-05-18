# File write runtime tool fixture

```yaml qa-scenario
id: runtime-tool-fs-write
title: Runtime tool fixture — fs.write
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.fs.write
objective: Verify file write behavior is tracked across Pi and Codex while Codex owns write natively.
successCriteria:
  - Pi may expose OpenClaw write while Codex app-server mode may omit duplicate OpenClaw dynamic write.
  - Mock provider write plans are reported as fixture intent, not as actual runtime tool calls.
  - The row stays report-only until the fixture validates native Codex write behavior directly.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.workspace-paths.test.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the write runtime tool family.
  config:
    toolName: write
    toolCoverage:
      family: fs.write
      actualTool: write
      bucket: codex-native-workspace
      expectedLayer: codex-native-workspace
      required: true
      tracking: "#80319"
      codexDefaultImpact: P4
      qaImpact: P1
      action: split native write behavior from OpenClaw dynamic tool parity
      reason: Codex app-server intentionally owns write natively; the fixture must not require OpenClaw dynamic write exposure.
    knownHarnessGap:
      issue: "#80319"
      reason: QA tool-defaults currently needs native write behavior coverage instead of OpenClaw dynamic write exposure.
    promptSnippet: "target=write"
    failurePromptSnippet: "failure target=write"
```

```yaml qa-flow
steps:
  - name: exercises fs.write happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
