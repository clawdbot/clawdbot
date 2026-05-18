# File list runtime tool fixture

```yaml qa-scenario
id: runtime-tool-fs-list
title: Runtime tool fixture — fs.list
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.fs.list
objective: Verify directory inspection behavior is tracked through read while Codex owns file inspection natively.
successCriteria:
  - Pi may expose OpenClaw read while Codex app-server mode may omit duplicate OpenClaw dynamic read.
  - Mock provider read plans are reported as fixture intent, not as actual runtime tool calls.
  - The row stays report-only until directory fault injection proves native Codex read behavior directly.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.read.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise fs.list coverage through the current read tool surface.
  config:
    toolName: read
    toolCoverage:
      family: fs.list
      actualTool: read
      bucket: codex-native-workspace
      expectedLayer: codex-native-workspace
      required: true
      tracking: "#80312"
      codexDefaultImpact: P4
      qaImpact: P2
      action: model native read/list behavior separately from provider-plan capture
      reason: Codex app-server intentionally owns read natively; current OpenClaw coding surface has no separate list tool.
    knownHarnessGap:
      issue: "#80312"
      reason: QA mock failure-path capture currently reports provider-plan args, not proven Codex native read/list behavior.
    promptSnippet: "target=read"
    failurePromptSnippet: "failure target=read"
```

```yaml qa-flow
steps:
  - name: exercises fs.list happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
