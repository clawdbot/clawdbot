# Codex plugin install race

```yaml qa-scenario
id: codex-plugin-install-race
title: Codex plugin install race
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.codex-plugin.lifecycle
  secondary:
    - runtime.turn-ordering
objective: Verify first agent turns wait on Codex plugin installation through deterministic ordering primitives, without sleep-based race assertions, lost tokens, or duplicate responses.
successCriteria:
  - The first turn records a waiting event before the install completion event.
  - The turn starts exactly once after the install completion event.
  - Input-token accounting survives the gate and responseCount remains 1.
docsRefs:
  - docs/cli/plugins.md
codeRefs:
  - extensions/qa-lab/src/codex-plugin.fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Exercise the deterministic install-vs-first-turn gate.
  config:
    expectedResponseCount: 1
    expectedText: QA_CODEX_PLUGIN_TURN_OK
```

```yaml qa-flow
steps:
  - name: validates deterministic install-race gate
    actions:
      - set: plugin
        value:
          expr: await qaImport("./codex-plugin.fixture.js")
      - set: gate
        value:
          expr: plugin.createCodexPluginInstallGate()
      - set: turn
        value:
          expr: "gate.runFirstTurnAfterInstall({ inputTokens: 17, run: () => config.expectedText })"
      - assert:
          expr: "JSON.stringify(gate.events) === JSON.stringify(['agent-turn:waiting-for-codex-plugin'])"
          message:
            expr: "`expected first turn to wait, got ${JSON.stringify(gate.events)}`"
      - call: gate.markInstalled
      - set: completed
        value:
          expr: await turn
      - assert:
          expr: "completed.text === config.expectedText && completed.responseCount === config.expectedResponseCount && completed.inputTokens === 17"
          message:
            expr: "`unexpected completed turn: ${JSON.stringify(completed)}`"
      - assert:
          expr: "JSON.stringify(gate.events) === JSON.stringify(['agent-turn:waiting-for-codex-plugin', 'codex-plugin:installed', 'agent-turn:started', 'agent-turn:completed'])"
          message:
            expr: "`unexpected install ordering: ${JSON.stringify(gate.events)}`"
      - assert:
          expr: "config.expectedResponseCount === 1"
          message: "first turn must produce one response"
    detailsExpr: "`expected=${completed.text} count=${completed.responseCount}`"
```
