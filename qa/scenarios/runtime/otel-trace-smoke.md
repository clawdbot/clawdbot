# OTEL trace smoke

```yaml qa-scenario
id: otel-trace-smoke
title: OTEL trace smoke
surface: telemetry
coverage:
  primary:
    - telemetry.otel
  secondary:
    - harness.qa-lab
objective: Verify a QA-lab gateway run emits bounded OpenTelemetry trace spans through the diagnostics-otel plugin.
successCriteria:
  - The diagnostics-otel plugin starts with trace export enabled.
  - A minimal QA-channel agent turn completes.
  - The trace includes the selected agent harness lifecycle span.
  - The run emits low-cardinality OpenTelemetry trace spans without content or raw diagnostic identifiers.
plugins:
  - diagnostics-otel
gatewayConfigPatch:
  diagnostics:
    enabled: true
    otel:
      enabled: true
      protocol: http/protobuf
      traces: true
      metrics: false
      logs: false
      sampleRate: 1
      captureContent:
        enabled: false
docsRefs:
  - docs/gateway/opentelemetry.md
  - docs/concepts/qa-e2e-automation.md
codeRefs:
  - extensions/diagnostics-otel/src/service.ts
  - src/agents/harness/v2.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Emit a minimal QA-lab trace with diagnostics-otel enabled.
  config:
    prompt: Reply exactly OTEL-QA-OK.
```

```yaml qa-flow
steps:
  - name: emits a traced qa-channel turn
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: reset
      - set: startCursor
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:otel-trace-smoke
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(startCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && String(candidate.text ?? '').trim().length > 0).at(-1)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "String(outbound.text ?? '').trim().length > 0"
          message: "expected non-empty qa output"
```
