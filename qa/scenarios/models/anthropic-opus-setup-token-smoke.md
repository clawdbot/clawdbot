# Anthropic Opus setup-token smoke

```yaml qa-scenario
id: anthropic-opus-setup-token-smoke
title: Anthropic Opus setup-token smoke
surface: model-provider
coverage:
  primary:
    - models.provider-auth
  secondary:
    - models.anthropic
objective: Verify the regular Anthropic Opus lane can complete a quick chat turn using setup-token auth.
successCriteria:
  - A live-frontier run fails fast unless the selected primary provider is anthropic.
  - The selected primary model is Anthropic Opus 4.6.
  - The QA gateway worker stages a token auth profile in the isolated agent store.
  - The agent replies through the regular Anthropic provider.
docsRefs:
  - docs/concepts/model-providers.md
  - docs/help/testing.md
codeRefs:
  - extensions/anthropic/register.runtime.ts
  - extensions/qa-lab/src/gateway-child.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Run with `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=<setup-token> pnpm openclaw qa suite --provider-mode live-frontier --model anthropic/claude-opus-4-6 --alt-model anthropic/claude-opus-4-6 --scenario anthropic-opus-setup-token-smoke`.
  config:
    requiredProvider: anthropic
    requiredModel: claude-opus-4-6
    profileId: "anthropic:qa-setup-token"
    chatPrompt: "Anthropic Opus setup-token smoke. Reply exactly: ANTHROPIC-OPUS-SETUP-TOKEN-OK"
    chatExpected: ANTHROPIC-OPUS-SETUP-TOKEN-OK
```

```yaml qa-flow
steps:
  - name: confirms regular Anthropic setup-token lane
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
      - assert:
          expr: "env.providerMode !== 'live-frontier' || env.gateway.cfg.auth?.profiles?.[config.profileId]?.mode === 'token'"
          message:
            expr: "`expected token profile ${config.profileId} in QA config`"
      - assert:
          expr: "env.providerMode !== 'live-frontier' || !env.gateway.runtimeEnv.OPENCLAW_LIVE_SETUP_TOKEN_VALUE"
          message: setup-token value should not be passed to the gateway child env
    detailsExpr: "env.providerMode === 'live-frontier' ? `provider=${selected?.provider} model=${selected?.model} auth=setup-token profile=${config.profileId}` : `mock-compatible provider=${selected?.provider}`"
  - name: talks through regular Anthropic Opus
    actions:
      - if:
          expr: "env.providerMode !== 'live-frontier'"
          then:
            - assert: "true"
          else:
            - call: reset
            - set: selected
              value:
                expr: splitModelRef(env.primaryModel)
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey: agent:qa:anthropic-opus-setup-token
                  message:
                    expr: config.chatPrompt
                  provider:
                    expr: selected?.provider
                  model:
                    expr: selected?.model
                  timeoutMs:
                    expr: resolveQaLiveTurnTimeoutMs(env, 60000, env.primaryModel)
            - call: waitForOutboundMessage
              saveAs: chatOutbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === 'qa-operator'"
                - expr: resolveQaLiveTurnTimeoutMs(env, 30000, env.primaryModel)
            - assert:
                expr: "chatOutbound.text.includes(config.chatExpected)"
                message:
                  expr: "`chat marker missing: ${chatOutbound.text}`"
    detailsExpr: "env.providerMode !== 'live-frontier' ? 'mock mode: skipped live Anthropic smoke' : chatOutbound.text"
```
