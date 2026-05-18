# Bash runtime tool fixture

```yaml qa-scenario
id: runtime-tool-bash
title: Runtime tool fixture — bash
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.bash
objective: Verify shell command behavior is tracked across Pi and Codex while Codex owns exec/process natively.
successCriteria:
  - Pi may expose OpenClaw exec while Codex app-server mode may omit duplicate OpenClaw dynamic exec/process.
  - Mock provider exec plans are reported as fixture intent, not as actual runtime tool calls.
  - The row stays report-only until the fixture validates native Codex command behavior directly.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.ts
  - src/agents/bash-tools.schemas.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the bash family through the OpenClaw exec tool.
  config:
    toolName: exec
    toolCoverage:
      family: bash
      actualTool: exec
      bucket: codex-native-workspace
      expectedLayer: codex-native-workspace
      required: true
      tracking: "#80319"
      codexDefaultImpact: P4
      qaImpact: P1
      action: split native command behavior from OpenClaw dynamic tool parity
      reason: Codex app-server intentionally owns command execution natively; the fixture must not require OpenClaw dynamic exec exposure.
    knownHarnessGap:
      issue: "#80319"
      reason: QA tool-defaults currently needs native command behavior coverage instead of OpenClaw dynamic exec exposure.
    promptSnippet: "target=exec"
    failurePromptSnippet: "failure target=exec"
```

```yaml qa-flow
steps:
  - name: exercises bash happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
