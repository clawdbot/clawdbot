# Medium game plan PI harness

```yaml qa-scenario
id: medium-game-plan-pi-harness
title: Medium game plan PI harness
surface: workspace
coverage:
  primary:
    - workspace.planning
  secondary:
    - agents.pi-harness
objective: Verify GPT-5.5 can use the PI harness to plan and build a medium-complex self-contained browser game.
successCriteria:
  - A live-frontier run fails fast unless the selected primary model is openai/gpt-5.5.
  - The scenario forces the embedded PI harness before the build turn.
  - The prompt explicitly asks the agent to enter plan mode before editing.
  - The agent writes a self-contained HTML game with a canvas loop, controls, scoring, waves, pause, and restart.
docsRefs:
  - docs/plugins/sdk-agent-harness.md
  - docs/gateway/configuration-reference.md
  - docs/help/testing.md
codeRefs:
  - src/agents/harness/selection.ts
  - src/agents/harness/builtin-pi.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Run with `pnpm openclaw qa suite --provider-mode live-frontier --model openai/gpt-5.5 --alt-model openai/gpt-5.5 --fast --thinking medium --scenario medium-game-plan-pi-harness`.
  config:
    requiredProvider: openai
    requiredModel: gpt-5.5
    harnessRuntime: pi
    harnessFallback: pi
    artifactFile: star-garden-defenders-pi.html
    gameTitle: Star Garden Defenders
    minBytes: 5000
    buildPrompt: |-
      Enter plan mode first and write a short implementation plan before editing.

      Then build a medium-complex, self-contained browser game at ./star-garden-defenders-pi.html.

      Game: Star Garden Defenders.
      Requirements:
      - one HTML file only; no external assets, fonts, scripts, or network calls
      - canvas-based arcade loop with requestAnimationFrame
      - keyboard controls and mouse or pointer support
      - player movement, enemy waves, collectibles or power-ups, collision handling
      - score, lives or health, wave number, pause, restart, and game-over state
      - polished inline CSS and clear on-screen controls
      - after writing the file, reply with the filename and the main systems implemented
```

```yaml qa-flow
steps:
  - name: confirms GPT-5.5 PI harness target
    actions:
      - set: selected
        value:
          expr: splitModelRef(env.primaryModel)
      - assert:
          expr: "env.providerMode !== 'live-frontier' || selected?.provider === config.requiredProvider"
          message:
            expr: "`expected live primary provider ${config.requiredProvider}, got ${env.primaryModel}`"
      - assert:
          expr: "env.providerMode !== 'live-frontier' || selected?.model === config.requiredModel"
          message:
            expr: "`expected live primary model ${config.requiredModel}, got ${env.primaryModel}`"
      - if:
          expr: "env.providerMode !== 'live-frontier'"
          then:
            - assert: "true"
          else:
            - call: patchConfig
              saveAs: patchResult
              args:
                - env:
                    ref: env
                  patch:
                    agents:
                      defaults:
                        embeddedHarness:
                          runtime:
                            expr: config.harnessRuntime
                          fallback:
                            expr: config.harnessFallback
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
                expr: "snapshot.config.agents?.defaults?.embeddedHarness?.runtime === config.harnessRuntime"
                message:
                  expr: "`expected embeddedHarness.runtime=${config.harnessRuntime}, got ${JSON.stringify(snapshot.config.agents?.defaults?.embeddedHarness)}`"
    detailsExpr: "env.providerMode === 'live-frontier' ? `provider=${selected?.provider} model=${selected?.model} runtime=${snapshot.config.agents?.defaults?.embeddedHarness?.runtime}` : `mock mode: parsed ${scenario.id}`"
  - name: builds the medium game artifact
    actions:
      - if:
          expr: "env.providerMode !== 'live-frontier'"
          then:
            - assert: "true"
          else:
            - call: reset
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey: agent:qa:medium-game-pi
                  message:
                    expr: config.buildPrompt
                  provider:
                    expr: selected?.provider
                  model:
                    expr: selected?.model
                  timeoutMs:
                    expr: resolveQaLiveTurnTimeoutMs(env, 420000, env.primaryModel)
            - call: waitForOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.artifactFile)"
                - expr: resolveQaLiveTurnTimeoutMs(env, 60000, env.primaryModel)
            - set: artifactPath
              value:
                expr: "path.join(env.gateway.workspaceDir, config.artifactFile)"
            - call: waitForCondition
              saveAs: artifact
              args:
                - lambda:
                    async: true
                    expr: "((await fs.readFile(artifactPath, 'utf8').catch(() => '')).includes(config.gameTitle) ? await fs.readFile(artifactPath, 'utf8').catch(() => '') : undefined)"
                - expr: resolveQaLiveTurnTimeoutMs(env, 60000, env.primaryModel)
                - 500
            - set: artifactLower
              value:
                expr: normalizeLowercaseStringOrEmpty(artifact)
            - assert:
                expr: "artifact.length >= config.minBytes"
                message:
                  expr: "`expected medium game artifact >= ${config.minBytes} bytes, got ${artifact.length}`"
            - assert:
                expr: "artifactLower.includes('star garden defenders') && artifactLower.includes('<canvas') && artifactLower.includes('requestanimationframe')"
                message: missing title, canvas, or animation loop
            - assert:
                expr: "artifactLower.includes('keydown') || artifactLower.includes('keyup')"
                message: missing keyboard controls
            - assert:
                expr: "artifactLower.includes('score') && artifactLower.includes('wave') && artifactLower.includes('pause') && artifactLower.includes('restart')"
                message: missing score, wave, pause, or restart systems
            - assert:
                expr: "outbound.text.includes(config.artifactFile)"
                message:
                  expr: "`final reply did not mention ${config.artifactFile}: ${outbound.text}`"
    detailsExpr: "env.providerMode !== 'live-frontier' ? 'mock mode: skipped live medium-game build' : `${config.artifactFile} bytes=${artifact.length}`"
```
