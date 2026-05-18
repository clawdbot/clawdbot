# Grep runtime tool fixture

```yaml qa-scenario
id: runtime-tool-grep
title: Runtime tool fixture — grep
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.grep
objective: Verify grep-style search behavior is tracked through command execution while Codex owns exec/process natively.
successCriteria:
  - Pi may expose OpenClaw exec while Codex app-server mode may omit duplicate OpenClaw dynamic exec/process.
  - Mock provider exec plans are reported as fixture intent, not as actual runtime tool calls.
  - The row stays report-only until the fixture validates native Codex search/command behavior directly.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise grep coverage through the current exec tool surface.
  config:
    toolName: exec
    toolCoverage:
      family: grep
      actualTool: exec
      bucket: codex-native-workspace
      expectedLayer: codex-native-workspace
      required: true
      tracking: "#80319"
      codexDefaultImpact: P4
      qaImpact: P1
      action: split native search/command behavior from OpenClaw dynamic tool parity
      reason: Codex app-server intentionally owns command execution natively; current OpenClaw coding surface routes grep-style searches through exec.
    knownHarnessGap:
      issue: "#80319"
      reason: QA tool-defaults currently needs native search/command behavior coverage instead of OpenClaw dynamic exec exposure.
    promptSnippet: "target=exec"
    failurePromptSnippet: "failure target=exec"
```

```yaml qa-flow
steps:
  - name: exercises grep happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
