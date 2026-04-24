# Codex harness no meta leak

```yaml qa-scenario
id: codex-harness-no-meta-leak
title: Codex harness no meta leak
surface: dm
coverage:
  primary:
    - models.codex-cli
  secondary:
    - runtime.no-meta-leak
objective: Verify the Codex app-server harness keeps coordination/meta chatter out of the visible reply.
successCriteria:
  - The scenario forces the Codex embedded harness and disables PI fallback.
  - The final visible reply includes the requested confirmation token.
  - The visible reply does not include internal coordination or progress chatter.
docsRefs:
  - docs/plugins/sdk-agent-harness.md
  - docs/concepts/qa-e2e-automation.md
  - docs/help/testing.md
codeRefs:
  - extensions/codex/src/app-server/event-projector.ts
  - extensions/qa-lab/src/reply-failure.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Run with `pnpm openclaw qa suite --provider-mode live-frontier --model openai/gpt-5.4 --alt-model openai/gpt-5.4 --fast --thinking medium --scenario codex-harness-no-meta-leak`.
  config:
    requiredProvider: codex
    requiredModel: gpt-5.4
    harnessRuntime: codex
    harnessFallback: none
    expectedReply: QA_LEAK_OK
    prompt: |-
      Think through your answer privately, but do not expose any internal planning, thread-context checks, or progress narration.

      Reply with exactly one line:
      QA_LEAK_OK
    forbiddenReplySubstrings:
      - checking thread context
      - thread context thin
      - post a tight progress reply here
      - posting a coordination nudge
      - posted a short coordination reply
      - not inventing status
```

```yaml qa-flow
steps:
  - name: confirms GPT-5.4 Codex harness target
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
            - assert:
                expr: "snapshot.config.agents?.defaults?.embeddedHarness?.fallback === config.harnessFallback"
                message:
                  expr: "`expected embeddedHarness.fallback=${config.harnessFallback}, got ${JSON.stringify(snapshot.config.agents?.defaults?.embeddedHarness)}`"
    detailsExpr: "env.providerMode === 'live-frontier' ? `provider=${selected?.provider} model=${selected?.model} runtime=${snapshot.config.agents?.defaults?.embeddedHarness?.runtime} fallback=${snapshot.config.agents?.defaults?.embeddedHarness?.fallback}` : `mock mode: parsed ${scenario.id}`"
  - name: keeps codex coordination chatter out of the visible reply
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
                - sessionKey: agent:qa:codex-meta-leak
                  message:
                    expr: config.prompt
                  provider:
                    expr: selected?.provider
                  model:
                    expr: selected?.model
                  timeoutMs:
                    expr: resolveQaLiveTurnTimeoutMs(env, 180000, env.primaryModel)
            - call: waitForOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.expectedReply)"
                - expr: resolveQaLiveTurnTimeoutMs(env, 60000, env.primaryModel)
            - set: outboundLower
              value:
                expr: normalizeLowercaseStringOrEmpty(outbound.text)
            - assert:
                expr: "outbound.text.trim() === config.expectedReply"
                message:
                  expr: "`expected exact visible reply ${config.expectedReply}, got ${outbound.text}`"
            - forEach:
                items:
                  expr: "config.forbiddenReplySubstrings ?? []"
                item: forbidden
                actions:
                  - assert:
                      expr: "!outboundLower.includes(normalizeLowercaseStringOrEmpty(forbidden))"
                      message:
                        expr: "`visible reply leaked internal meta text (${forbidden}): ${outbound.text}`"
    detailsExpr: "env.providerMode !== 'live-frontier' ? 'mock mode: skipped live codex leak check' : outbound.text"
```
