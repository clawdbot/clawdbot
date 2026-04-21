# GPT-5.4 thinking visibility switch

```yaml qa-scenario
id: gpt54-thinking-visibility-switch
title: GPT-5.4 thinking visibility switch
surface: models
coverage:
  primary:
    - models.thinking
  secondary:
    - runtime.reasoning-visibility
objective: Verify GPT-5.4 can switch from disabled thinking to max thinking while reasoning display stays enabled.
successCriteria:
  - Live runs target openai/gpt-5.4, not a mini or pro variant.
  - The session enables reasoning display before the comparison turns.
  - The disabled-thinking turn returns its visible marker without a Reasoning-prefixed message.
  - The max-thinking turn returns its visible marker and a separate Reasoning-prefixed message.
docsRefs:
  - docs/tools/thinking.md
  - docs/help/testing.md
  - docs/concepts/qa-e2e-automation.md
codeRefs:
  - src/auto-reply/reply/directives.ts
  - src/auto-reply/thinking.shared.ts
  - src/agents/pi-embedded-runner/run/payloads.ts
  - extensions/openai/openai-provider.ts
  - extensions/qa-lab/src/providers/mock-openai/server.ts
execution:
  kind: flow
  summary: Toggle reasoning display and GPT-5.4 thinking between off/none and max/high, then verify visible reasoning only on the max turn.
  config:
    requiredLiveProvider: openai
    requiredLiveModel: gpt-5.4
    offDirective: /think off
    maxDirective: /think max
    reasoningDirective: /reasoning on
    conversationId: qa-thinking-visibility
    offPrompt: "QA thinking visibility check off: answer exactly THINKING-OFF-OK."
    maxPrompt: "QA thinking visibility check max: verify 17+24=41 internally, then answer exactly THINKING-MAX-OK."
    offMarker: THINKING-OFF-OK
    maxMarker: THINKING-MAX-OK
```

```yaml qa-flow
steps:
  - name: enables reasoning display and disables thinking
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
      - set: selected
        value:
          expr: splitModelRef(env.primaryModel)
      - assert:
          expr: "env.providerMode !== 'live-frontier' || (selected?.provider === config.requiredLiveProvider && selected?.model === config.requiredLiveModel)"
          message:
            expr: "`expected live GPT-5.4, got ${env.primaryModel}`"
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text:
              expr: config.reasoningDirective
      - call: waitForCondition
        saveAs: reasoningAck
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Reasoning visibility enabled/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text:
              expr: config.offDirective
      - call: waitForCondition
        saveAs: offAck
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Thinking disabled/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
      - set: offCursor
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
            text:
              expr: "`${config.offDirective} ${config.offPrompt}`"
      - call: waitForCondition
        saveAs: offAnswer
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(offCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && candidate.text.includes(config.offMarker)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 30000)
      - set: offMessages
        value:
          expr: "state.getSnapshot().messages.slice(offCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId)"
      - assert:
          expr: "offMessages.some((candidate) => candidate.text.includes(config.offMarker))"
          message:
            expr: "`missing off marker; saw ${offMessages.map((message) => message.text).join(' | ')}`"
      - assert:
          expr: "!offMessages.some((candidate) => candidate.text.trimStart().startsWith('Reasoning:'))"
          message:
            expr: "`disabled thinking unexpectedly emitted reasoning: ${offMessages.map((message) => message.text).join(' | ')}`"
      - if:
          expr: "Boolean(env.mock)"
          then:
            - set: requests
              value:
                expr: "await fetchJson(`${env.mock.baseUrl}/debug/requests`)"
            - set: offRequest
              value:
                expr: "requests.find((request) => String(request.allInputText ?? '').includes(config.offPrompt))"
            - assert:
                expr: "String(offRequest?.model ?? '').includes('gpt-5.4')"
                message:
                  expr: "`expected GPT-5.4 off mock request, got ${String(offRequest?.model ?? '')}`"
    detailsExpr: "`off ack=${offAck.text}; off answer=${offAnswer.text}`"
  - name: switches to max thinking
    actions:
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: qa-operator
            senderName: QA Operator
            text:
              expr: config.maxDirective
      - call: waitForCondition
        saveAs: maxAck
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Thinking level set to high/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
    detailsExpr: "`max ack=${maxAck.text}`"
  - name: verifies max thinking emits visible reasoning
    actions:
      - set: maxCursor
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
            text:
              expr: "`${config.maxDirective} ${config.maxPrompt}`"
      - call: waitForCondition
        saveAs: maxReasoning
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(maxCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && candidate.text.trimStart().startsWith('Reasoning:')).at(-1)"
          - expr: liveTurnTimeoutMs(env, 120000)
      - assert:
          expr: "maxReasoning.text.trimStart().startsWith('Reasoning:')"
          message:
            expr: "`missing max reasoning message near answer: ${recentOutboundSummary(state, 6)}`"
    detailsExpr: "`reasoning=${maxReasoning.text}`"
  - name: verifies max thinking completes the answer
    actions:
      - call: waitForCondition
        saveAs: maxAnswer
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(maxCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && candidate.text.includes(config.maxMarker)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 120000)
      - assert:
          expr: "maxAnswer.text.includes(config.maxMarker)"
          message:
            expr: "`missing max marker: ${maxAnswer.text}`"
      - if:
          expr: "Boolean(env.mock)"
          then:
            - set: requests
              value:
                expr: "await fetchJson(`${env.mock.baseUrl}/debug/requests`)"
            - set: maxRequest
              value:
                expr: "requests.find((request) => String(request.allInputText ?? '').includes(config.maxPrompt))"
            - assert:
                expr: "String(maxRequest?.model ?? '').includes('gpt-5.4')"
                message:
                  expr: "`expected GPT-5.4 mock request, got ${String(maxRequest?.model ?? '')}`"
    detailsExpr: "`answer=${maxAnswer.text}`"
```
