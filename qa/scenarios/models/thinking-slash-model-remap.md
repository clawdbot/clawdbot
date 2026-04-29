# Thinking slash model remap

```yaml qa-scenario
id: thinking-slash-model-remap
title: Thinking slash model remap
surface: models
coverage:
  primary:
    - models.thinking
  secondary:
    - models.switching
    - runtime.session-continuity
objective: Verify /think lists provider-owned levels and remaps stored thinking levels when the session model changes provider capabilities.
plugins:
  - anthropic
gatewayConfigPatch:
  agents:
    defaults:
      models:
        anthropic/claude-sonnet-4-6:
          params: {}
successCriteria:
  - Anthropic Claude Sonnet 4.6 advertises adaptive but not OpenAI-only xhigh or Opus max.
  - A stored adaptive level remaps to medium when switching to OpenAI GPT-5.5.
  - OpenAI GPT-5.5 advertises xhigh but not adaptive or max.
  - A stored xhigh level remaps to high when switching to an Anthropic model without xhigh support.
docsRefs:
  - docs/tools/thinking.md
  - docs/help/testing.md
  - docs/concepts/qa-e2e-automation.md
codeRefs:
  - src/auto-reply/thinking.ts
  - src/auto-reply/thinking.shared.ts
  - src/auto-reply/reply/directive-handling.impl.ts
  - src/gateway/sessions-patch.ts
  - extensions/anthropic/register.runtime.ts
  - extensions/openai/openai-provider.ts
execution:
  kind: flow
  summary: Select Anthropic, set adaptive, switch to OpenAI and verify medium fallback, then set xhigh and verify high fallback on a non-xhigh model.
  config:
    requiredProviderMode: live-frontier
    requiredProvider: openai
    requiredModel: gpt-5.5
    anthropicModelRef: anthropic/claude-sonnet-4-6
    openAiXhighModelRef: openai/gpt-5.5
    noXhighModelRef: anthropic/claude-sonnet-4-6
    conversationId: thinking-slash-remap
    sessionKey: agent:qa:main
```

```yaml qa-flow
steps:
  - name: selects Anthropic and verifies adaptive options
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
      - assert:
          expr: "env.providerMode === config.requiredProviderMode"
          message:
            expr: "`thinking remap scenario requires ${config.requiredProviderMode}; got ${env.providerMode}`"
      - set: anthropicModelAck
        value:
          expr: "await env.gateway.call('sessions.patch', { key: config.sessionKey, model: config.anthropicModelRef }, { timeoutMs: liveTurnTimeoutMs(env, 45000) })"
      - set: cursor
        value:
          expr: state.getSnapshot().messages.length
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text: /think
      - call: waitForCondition
        saveAs: anthropicThinkStatus
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(cursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Current thinking level:/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
      - assert:
          expr: "/Options: .*adaptive/i.test(anthropicThinkStatus.text)"
          message:
            expr: "`expected Anthropic /think options to include adaptive, got ${anthropicThinkStatus.text}`"
      - assert:
          expr: "!/Options: .*\\bxhigh\\b/i.test(anthropicThinkStatus.text) && !/Options: .*\\bmax\\b/i.test(anthropicThinkStatus.text)"
          message:
            expr: "`expected Sonnet /think options to omit xhigh/max, got ${anthropicThinkStatus.text}`"
    detailsExpr: "`model=${JSON.stringify(anthropicModelAck.resolved)}; think=${anthropicThinkStatus.text}`"
  - name: maps adaptive to medium when switching to OpenAI
    actions:
      - set: cursor
        value:
          expr: state.getSnapshot().messages.length
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text: /think adaptive
      - call: waitForCondition
        saveAs: adaptiveAck
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(cursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Thinking level set to adaptive/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
      - set: openAiModelAck
        value:
          expr: "await env.gateway.call('sessions.patch', { key: config.sessionKey, model: config.openAiXhighModelRef }, { timeoutMs: liveTurnTimeoutMs(env, 45000) })"
      - assert:
          expr: "openAiModelAck.entry?.thinkingLevel === 'medium'"
          message:
            expr: "`expected adaptive->medium remap, got ${JSON.stringify(openAiModelAck.entry)}`"
      - set: cursor
        value:
          expr: state.getSnapshot().messages.length
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text: /think
      - call: waitForCondition
        saveAs: openAiThinkStatus
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(cursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Current thinking level: medium/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
      - assert:
          expr: "/Options: .*\\bxhigh\\b/i.test(openAiThinkStatus.text) && !/Options: .*\\badaptive\\b/i.test(openAiThinkStatus.text) && !/Options: .*\\bmax\\b/i.test(openAiThinkStatus.text)"
          message:
            expr: "`expected OpenAI GPT-5.5 /think options to include xhigh only, got ${openAiThinkStatus.text}`"
    detailsExpr: "`adaptive=${adaptiveAck.text}; switch=${JSON.stringify(openAiModelAck.resolved)}; think=${openAiThinkStatus.text}`"
  - name: maps xhigh to high on a model without xhigh
    actions:
      - set: cursor
        value:
          expr: state.getSnapshot().messages.length
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text: /think xhigh
      - call: waitForCondition
        saveAs: xhighAck
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(cursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Thinking level set to xhigh/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
      - set: noXhighModelAck
        value:
          expr: "await env.gateway.call('sessions.patch', { key: config.sessionKey, model: config.noXhighModelRef }, { timeoutMs: liveTurnTimeoutMs(env, 45000) })"
      - assert:
          expr: "noXhighModelAck.entry?.thinkingLevel === 'high'"
          message:
            expr: "`expected xhigh->high remap, got ${JSON.stringify(noXhighModelAck.entry)}`"
      - set: cursor
        value:
          expr: state.getSnapshot().messages.length
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text: /think
      - call: waitForCondition
        saveAs: noXhighThinkStatus
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(cursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Current thinking level: high/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
      - assert:
          expr: "/Options: .*\\badaptive\\b/i.test(noXhighThinkStatus.text) && !/Options: .*\\bxhigh\\b/i.test(noXhighThinkStatus.text) && !/Options: .*\\bmax\\b/i.test(noXhighThinkStatus.text)"
          message:
            expr: "`expected non-xhigh model /think options to include adaptive and omit xhigh/max, got ${noXhighThinkStatus.text}`"
    detailsExpr: "`xhigh=${xhighAck.text}; switch=${JSON.stringify(noXhighModelAck.resolved)}; think=${noXhighThinkStatus.text}`"
```
