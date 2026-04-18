# Anthropic Opus API key smoke

```yaml qa-scenario
id: anthropic-opus-api-key-smoke
title: Anthropic Opus API key smoke
surface: model-provider
coverage:
  primary:
    - models.provider-auth
  secondary:
    - models.anthropic
objective: Verify the regular Anthropic Opus lane can complete a quick chat turn using API-key auth.
successCriteria:
  - A live-frontier run fails fast unless the selected primary provider is anthropic.
  - The selected primary model is Anthropic Opus 4.6.
  - The QA gateway worker has an Anthropic API key available through environment auth.
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
  summary: Run with `pnpm openclaw qa suite --provider-mode live-frontier --model anthropic/claude-opus-4-6 --alt-model anthropic/claude-opus-4-6 --scenario anthropic-opus-api-key-smoke`.
  config:
    requiredProvider: anthropic
    requiredModel: claude-opus-4-6
    chatPrompt: "Anthropic Opus API key smoke. Reply exactly: ANTHROPIC-OPUS-API-KEY-OK"
    chatExpected: ANTHROPIC-OPUS-API-KEY-OK
```

```yaml qa-flow
steps:
  - name: confirms regular Anthropic API-key lane
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
          expr: "env.providerMode !== 'live-frontier' || Boolean(env.gateway.runtimeEnv.ANTHROPIC_API_KEY?.trim())"
          message: expected ANTHROPIC_API_KEY to be available for API-key QA mode
    detailsExpr: "env.providerMode === 'live-frontier' ? `provider=${selected?.provider} model=${selected?.model} auth=env-api-key` : `mock-compatible provider=${selected?.provider}`"
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
                - sessionKey: agent:qa:anthropic-opus-api-key
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
