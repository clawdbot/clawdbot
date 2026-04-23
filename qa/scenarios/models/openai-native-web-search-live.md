# OpenAI native web search live

```yaml qa-scenario
id: openai-native-web-search-live
title: OpenAI native web search live
surface: model-provider
coverage:
  primary:
    - tools.web-search
  secondary:
    - models.openai
objective: Verify a live OpenAI GPT model can use OpenAI native web_search when OpenClaw web search is enabled in auto mode.
successCriteria:
  - A live-frontier run fails fast unless the selected primary provider is openai.
  - The selected primary model is GPT-5.5, not a mini or pro variant.
  - Web search is enabled without pinning a managed web_search provider.
  - The live reply includes the required marker plus an official OpenAI News URL and headline found through web search.
gatewayConfigPatch:
  tools:
    web:
      search:
        enabled: true
        provider: null
docsRefs:
  - docs/tools/web.md
  - docs/help/testing.md
  - docs/concepts/qa-e2e-automation.md
codeRefs:
  - extensions/openai/native-web-search.ts
  - extensions/openai/shared.ts
  - extensions/openai/openai-provider.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Run with `OPENCLAW_LIVE_OPENAI_KEY="${OPENAI_API_KEY}" pnpm openclaw qa suite --provider-mode live-frontier --model openai/gpt-5.5 --alt-model openai/gpt-5.5 --scenario openai-native-web-search-live`.
  config:
    requiredProvider: openai
    requiredModel: gpt-5.5
    expectedMarker: WEB-SEARCH-OK
    failureMarker: WEB-SEARCH-FAILED
    searchPrompt: |-
      Web search QA: use web search now for `site:openai.com/news OpenAI latest news`.
      Reply in exactly three lines:
      WEB-SEARCH-OK
      URL: <official openai.com/news URL from the search results>
      HEADLINE: <article or page headline from the search results>
      Do not answer from memory. If web search is unavailable, reply exactly WEB-SEARCH-FAILED.
```

```yaml qa-flow
steps:
  - name: confirms live OpenAI GPT-5.5 web search auto mode
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
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
      - call: readConfigSnapshot
        saveAs: snapshot
        args:
          - ref: env
      - set: searchConfig
        value:
          expr: "snapshot.config.tools?.web?.search ?? {}"
      - assert:
          expr: "searchConfig.enabled !== false"
          message:
            expr: "`expected web search enabled, got ${JSON.stringify(searchConfig)}`"
      - assert:
          expr: "typeof searchConfig.provider !== 'string' || ['auto', 'openai', ''].includes(searchConfig.provider.trim().toLowerCase())"
          message:
            expr: "`expected web search provider auto/openai/unset for native OpenAI search, got ${JSON.stringify(searchConfig)}`"
      - assert:
          expr: "env.providerMode !== 'live-frontier' || Boolean(env.gateway.runtimeEnv.OPENAI_API_KEY?.trim() || env.gateway.runtimeEnv.OPENCLAW_LIVE_OPENAI_KEY?.trim())"
          message: expected OPENAI_API_KEY or OPENCLAW_LIVE_OPENAI_KEY for live OpenAI QA
    detailsExpr: "env.providerMode === 'live-frontier' ? `provider=${selected?.provider} model=${selected?.model} webSearch=${JSON.stringify(searchConfig)}` : `mock-compatible provider=${selected?.provider}`"
  - name: searches official OpenAI News through the live model
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
                - sessionKey: agent:qa:openai-native-web-search
                  message:
                    expr: config.searchPrompt
                  provider:
                    expr: selected?.provider
                  model:
                    expr: selected?.model
                  timeoutMs:
                    expr: resolveQaLiveTurnTimeoutMs(env, 180000, env.primaryModel)
            - call: waitForOutboundMessage
              saveAs: searchOutbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === 'qa-operator'"
                - expr: resolveQaLiveTurnTimeoutMs(env, 60000, env.primaryModel)
            - set: searchText
              value:
                expr: searchOutbound.text
            - set: searchTextLower
              value:
                expr: normalizeLowercaseStringOrEmpty(searchText)
            - assert:
                expr: "searchText.includes(config.expectedMarker)"
                message:
                  expr: "`missing ${config.expectedMarker}: ${searchText}`"
            - assert:
                expr: "!searchText.includes(config.failureMarker) && !/(web search is unavailable|unable to search|cannot search|can't search)/i.test(searchText)"
                message:
                  expr: "`search looked unavailable: ${searchText}`"
            - assert:
                expr: "/URL:\\s*https?:\\/\\/[^\\s]*openai\\.com\\/news/i.test(searchText)"
                message:
                  expr: "`missing official OpenAI News URL: ${searchText}`"
            - assert:
                expr: "/HEADLINE:\\s*\\S.{8,}/i.test(searchText)"
                message:
                  expr: "`missing searched headline: ${searchText}`"
    detailsExpr: "env.providerMode !== 'live-frontier' ? 'mock mode: skipped live OpenAI web search probe' : searchText"
```
