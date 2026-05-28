# Session status runtime tool fixture

```yaml qa-scenario
id: runtime-tool-session-status
title: Runtime tool fixture — session_status
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.session-status
objective: Verify session_status preserves arguments and result shape across OpenClaw and Codex.
successCriteria:
  - Effective tools expose session_status.
  - The mock provider plans exactly one happy-path session_status call.
  - The mock provider plans one denied-input failure-path session_status call.
  - Runtime parity coverage hard-fails call/result drift in the standard direct-loading gate.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/session-status-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the session_status runtime tool family.
  config:
    toolName: session_status
    toolCoverage:
      family: session_status
      actualTool: session_status
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      capabilityLayer: openclaw-dynamic-direct
      required: true
      codexDefaultImpact: P4
      qaImpact: P1
      action: hard gate in the standard direct-loading tier
      reason: session_status is an OpenClaw integration tool and must stay visible and callable under OpenClaw and Codex direct runtime parity.
    promptSnippet: "target=session_status"
    failurePromptSnippet: "failure target=session_status"
```

```yaml qa-flow
steps:
  - name: exercises session_status happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
