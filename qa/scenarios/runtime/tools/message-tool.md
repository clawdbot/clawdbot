# Direct message runtime tool fixture

```yaml qa-scenario
id: runtime-tool-message-tool
title: Runtime tool fixture — direct message tool
surface: runtime-tools
runtimeParityTier: optional
coverage:
  primary:
    - tools.message-tool
objective: Report whether a direct message tool is present. The coding-profile session surface normally uses sessions_send instead.
successCriteria:
  - The fixture is report-only when the coding profile does not expose a direct message tool.
  - If a direct message tool is exposed, the mock provider plans exactly one happy-path message call.
  - If a direct message tool is exposed, the mock provider plans one denied-input failure-path message call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-embedded-messaging.ts
  - src/agents/tools/sessions-send-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Inventory the direct message runtime tool family.
  config:
    toolName: message
    expectedAvailable: false
    toolCoverage:
      family: message-tool
      actualTool: message
      bucket: optional-profile-or-plugin
      expectedLayer: profile-or-plugin
      required: false
      codexDefaultImpact: P4
      qaImpact: P4
      action: keep report-only in coding profile
      reason: Direct message is not part of the coding-profile default surface; session messaging uses sessions_send.
    promptSnippet: "target=message"
    failurePromptSnippet: "failure target=message"
```

```yaml qa-flow
steps:
  - name: exercises message happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
