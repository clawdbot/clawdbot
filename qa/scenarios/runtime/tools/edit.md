# Edit runtime tool fixture

```yaml qa-scenario
id: runtime-tool-edit
title: Runtime tool fixture — edit
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.edit
objective: Verify targeted edit behavior is tracked across Pi and Codex while Codex owns edit natively.
successCriteria:
  - Pi may expose OpenClaw edit while Codex app-server mode may omit duplicate OpenClaw dynamic edit.
  - Mock provider edit plans are reported as fixture intent, not as actual runtime tool calls.
  - The row stays report-only until the fixture validates native Codex edit behavior directly.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the edit runtime tool family.
  config:
    toolName: edit
    toolCoverage:
      family: edit
      actualTool: edit
      bucket: codex-native-workspace
      expectedLayer: codex-native-workspace
      required: true
      tracking: "#80319"
      codexDefaultImpact: P4
      qaImpact: P1
      action: split native edit behavior from OpenClaw dynamic tool parity
      reason: Codex app-server intentionally owns edit natively; the fixture must not require OpenClaw dynamic edit exposure.
    knownHarnessGap:
      issue: "#80319"
      reason: QA tool-defaults currently needs native edit behavior coverage instead of OpenClaw dynamic edit exposure.
    promptSnippet: "target=edit"
    failurePromptSnippet: "failure target=edit"
```

```yaml qa-flow
steps:
  - name: exercises edit happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
