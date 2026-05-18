# File read runtime tool fixture

```yaml qa-scenario
id: runtime-tool-fs-read
title: Runtime tool fixture — fs.read
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.fs.read
objective: Verify file read behavior is tracked across Pi and Codex while Codex owns read natively.
successCriteria:
  - Pi may expose OpenClaw read while Codex app-server mode may omit duplicate OpenClaw dynamic read.
  - Mock provider read plans are reported as fixture intent, not as actual runtime tool calls.
  - The row stays report-only until failure-path injection proves native Codex read behavior directly.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.read.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the read runtime tool family.
  config:
    toolName: read
    toolCoverage:
      family: fs.read
      actualTool: read
      bucket: codex-native-workspace
      expectedLayer: codex-native-workspace
      required: true
      tracking: "#80312"
      codexDefaultImpact: P4
      qaImpact: P2
      action: model native read behavior separately from provider-plan capture
      reason: Codex app-server intentionally owns read natively; QA mock failure-path capture currently reports provider-plan args, not proven Codex native read behavior.
    knownHarnessGap:
      issue: "#80312"
      reason: QA mock failure-path capture currently reports provider-plan args, not proven Codex native read behavior.
    promptSnippet: "target=read"
    failurePromptSnippet: "failure target=read"
```

```yaml qa-flow
steps:
  - name: exercises fs.read happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
