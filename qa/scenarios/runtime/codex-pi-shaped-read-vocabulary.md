# Codex Pi-shaped Read vocabulary canary

```yaml qa-scenario
id: codex-pi-shaped-read-vocabulary
title: Codex Pi-shaped Read vocabulary canary
surface: runtime
runtimeParityTier: live-only
coverage:
  primary:
    - runtime.codex-native-workspace.read
  secondary:
    - runtime.prompt-compatibility
    - tools.fs.read
objective: Verify Codex-mode agents can satisfy legacy Pi-shaped "Read tool" wording through the native Codex workspace-read capability instead of stopping because duplicate OpenClaw dynamic read is intentionally filtered.
successCriteria:
  - Agent reads the seeded workspace file and replies with the exact marker line.
  - Agent does not claim that the Read tool is unavailable.
  - Any failure is classified as a native prompt-compatibility/product behavior gap, not as missing OpenClaw dynamic read exposure.
docsRefs:
  - docs/plugins/codex-harness.md
  - docs/tools/tool-search.md
codeRefs:
  - extensions/codex/src/app-server/dynamic-tool-profile.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Seed a workspace file, ask with Pi-shaped "Read tool" wording, and require Codex to complete the read through its native workspace capability.
  config:
    runtimeParityComparison: codex-native-workspace
    fixtureFile: PI_SHAPED_READ_FIXTURE.txt
    expectedMarker: PI_SHAPED_READ_OK
    unavailableNeedles:
      - not in my available tool surface
      - read tool is not
      - no read tool
      - not available
      - cannot access
      - unable to access
      - do not have access
```

```yaml qa-flow
steps:
  - name: handles Pi-shaped Read tool wording with native Codex read
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
      - set: fixturePath
        value:
          expr: "path.join(env.gateway.workspaceDir, config.fixtureFile)"
      - call: fs.writeFile
        args:
          - ref: fixturePath
          - expr: "`${config.expectedMarker}\\n`"
          - utf8
      - set: startIndex
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: "`agent:qa:pi-shaped-read:${randomUUID().slice(0, 8)}`"
            message:
              expr: "`Use the Read tool to read ${fixturePath}. Reply with the exact marker line and nothing else.`"
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - set: unavailableNeedles
        value:
          expr: "config.unavailableNeedles.map(normalizeLowercaseStringOrEmpty)"
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && (normalizeLowercaseStringOrEmpty(candidate.text).includes(normalizeLowercaseStringOrEmpty(config.expectedMarker)) || unavailableNeedles.some((needle) => normalizeLowercaseStringOrEmpty(candidate.text).includes(needle)))"
          - expr: liveTurnTimeoutMs(env, 30000)
          - sinceIndex:
              ref: startIndex
      - set: outboundText
        value:
          expr: "String(outbound.text ?? '')"
      - set: normalizedOutbound
        value:
          expr: "normalizeLowercaseStringOrEmpty(outboundText)"
      - assert:
          expr: "normalizedOutbound.includes(normalizeLowercaseStringOrEmpty(config.expectedMarker))"
          message:
            expr: "`Pi-shaped Read vocabulary canary did not read marker ${config.expectedMarker}; outbound=${outboundText}`"
      - assert:
          expr: "!unavailableNeedles.some((needle) => normalizedOutbound.includes(needle))"
          message:
            expr: "`Pi-shaped Read vocabulary canary stopped on unavailable Read-tool wording: ${outboundText}`"
    detailsExpr: outbound.text
```
