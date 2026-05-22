# Long-context progress watchdog

```yaml qa-scenario
id: long-context-progress-watchdog
title: Long-context progress watchdog
surface: runtime
runtimeParityTier: live-only
coverage:
  primary:
    - runtime.gateway-log-sentinel.codex-progress
  secondary:
    - runtime.long-context
    - runtime.codex-app-server
objective: Fail live proof when long-context activity triggers Codex app-server timeout or stalled-progress sentinels.
successCriteria:
  - Gateway config routes the selected QA model through the Codex app-server runtime.
  - Agent reads through the seeded long-context fixture and replies with the marker found at the tail.
  - Gateway logs since the scenario cursor contain no app-server timeout or stalled-progress sentinel.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/gateway-log-sentinel.ts
  - extensions/codex/src/app-server
execution:
  kind: flow
  summary: Seed a large workspace fixture, complete a read turn, and scan for Codex app-server progress failures.
  config:
    requiredProviderMode: live-frontier
    harnessRuntime: codex
    fixtureFile: LONG_CONTEXT_SENTINEL_FIXTURE.txt
    expectedMarker: LONG-CONTEXT-WATCHDOG-OK
    repeatCount: 2000
```

```yaml qa-flow
steps:
  - name: catches app-server timeout or stalled progress during long-context activity
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: readConfigSnapshot
        saveAs: originalSnapshot
        args:
          - ref: env
      - set: originalModelEntry
        value:
          expr: originalSnapshot.config.agents?.defaults?.models?.[env.primaryModel]
      - set: originalPluginAllow
        value:
          expr: originalSnapshot.config.plugins?.allow
      - set: originalCodexPluginEntry
        value:
          expr: originalSnapshot.config.plugins?.entries?.codex
      - try:
          actions:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    plugins:
                      allow:
                        expr: "Array.from(new Set([...(Array.isArray(originalPluginAllow) ? originalPluginAllow : []), 'codex']))"
                      entries:
                        codex:
                          expr: "({ ...((originalCodexPluginEntry && typeof originalCodexPluginEntry === 'object') ? originalCodexPluginEntry : {}), enabled: true })"
                    agents:
                      defaults:
                        models:
                          expr: "({ [env.primaryModel]: { agentRuntime: { id: config.harnessRuntime } } })"
            - call: waitForGatewayHealthy
              args:
                - ref: env
                - 60000
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
            - call: readConfigSnapshot
              saveAs: snapshot
              args:
                - ref: env
            - assert:
                expr: "snapshot.config.agents?.defaults?.models?.[env.primaryModel]?.agentRuntime?.id === config.harnessRuntime"
                message:
                  expr: "`expected ${env.primaryModel} agentRuntime.id=${config.harnessRuntime}, got ${JSON.stringify(snapshot.config.agents?.defaults?.models?.[env.primaryModel]?.agentRuntime)}`"
            - call: reset
            - set: logCursor
              value:
                expr: markGatewayLogCursor()
            - set: fixturePath
              value:
                expr: "path.join(env.gateway.workspaceDir, config.fixtureFile)"
            - call: fs.writeFile
              args:
                - ref: fixturePath
                - expr: "`START LONG-CONTEXT-WATCHDOG\\n${Array.from({ length: config.repeatCount }, (_entry, index) => `context row ${index + 1}: alpha beta gamma`).join('\\n')}\\nTAIL ${config.expectedMarker}\\n`"
                - utf8
            - set: startIndex
              value:
                expr: state.getSnapshot().messages.length
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey:
                    expr: "`agent:qa:long-context-watchdog:${randomUUID().slice(0, 8)}`"
                  message:
                    expr: "`Read ${fixturePath}, find the marker on the TAIL line, and reply with that marker only.`"
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 90000)
            - call: waitForOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === 'qa-operator' && normalizeLowercaseStringOrEmpty(candidate.text).includes(normalizeLowercaseStringOrEmpty(config.expectedMarker))"
                - expr: liveTurnTimeoutMs(env, 45000)
                - sinceIndex:
                    ref: startIndex
            - call: assertNoGatewayLogSentinels
              args:
                - since:
                    ref: logCursor
                  kinds:
                    - codex-app-server-timeout
                    - stalled-agent-run
          finally:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    plugins:
                      allow:
                        expr: "originalPluginAllow === undefined ? null : originalPluginAllow"
                      entries:
                        codex:
                          expr: "originalCodexPluginEntry === undefined ? null : { ...originalCodexPluginEntry, enabled: originalCodexPluginEntry.enabled === undefined ? null : originalCodexPluginEntry.enabled }"
                    agents:
                      defaults:
                        models:
                          expr: "({ [env.primaryModel]: originalModelEntry === undefined ? null : { ...originalModelEntry, agentRuntime: originalModelEntry.agentRuntime === undefined ? null : originalModelEntry.agentRuntime } })"
            - call: waitForGatewayHealthy
              args:
                - ref: env
                - 60000
    detailsExpr: outbound.text
```
