# GPT-5.5 thinking visibility switch

```yaml qa-scenario
id: gpt55-thinking-visibility-switch
title: GPT-5.5 thinking visibility switch
surface: models
coverage:
  primary:
    - models.thinking
  secondary:
    - runtime.reasoning-visibility
objective: Verify GPT-5.5 can switch from disabled thinking to medium thinking while reasoning display stays enabled.
successCriteria:
  - Live runs target openai/gpt-5.5, not a mini or pro variant.
  - The session enables reasoning display before the comparison turns.
  - The disabled-thinking turn returns its visible marker without sending a reasoning payload to OpenAI-compatible providers.
  - The medium-thinking turn sends a medium reasoning request and returns its visible marker.
  - Transports with a visible reasoning lane expose a separate Reasoning-prefixed message; qa-channel validates provider behavior because generic delivery suppresses reasoning payloads by design.
docsRefs:
  - docs/tools/thinking.md
  - docs/help/testing.md
  - docs/concepts/qa-e2e-automation.md
codeRefs:
  - src/auto-reply/reply/directives.ts
  - src/auto-reply/thinking.shared.ts
  - src/agents/embedded-agent-runner/run/payloads.ts
  - extensions/openai/openai-provider.ts
  - extensions/qa-lab/src/providers/mock-openai/server.ts
execution:
  kind: flow
  summary: Toggle reasoning display and GPT-5.5 thinking between off/none and medium, then verify visible reasoning only on the medium turn.
  config:
    requiredProvider: openai
    requiredModel: gpt-5.5
    offDirective: /think off
    maxDirective: /think medium
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
          expr: "env.providerMode !== 'live-frontier' || (selected?.provider === config.requiredProvider && selected?.model === config.requiredModel)"
          message:
            expr: "`expected live GPT-5.5, got ${env.primaryModel}`"
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
      - set: thinkOffCursor
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
              expr: config.offDirective
      - call: waitForCondition
        saveAs: thinkOffAck
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(thinkOffCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Thinking disabled/i.test(candidate.text)).at(-1)"
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
              expr: config.offPrompt
      - call: waitForCondition
        saveAs: offAnswer
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(offCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && candidate.text.includes(config.offMarker)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 90000)
      - set: offMessages
        value:
          expr: "state.getSnapshot().messages.slice(offCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId)"
      - assert:
          expr: "offMessages.some((candidate) => candidate.text.includes(config.offMarker))"
          message:
            expr: "`missing off marker; saw ${offMessages.map((message) => message.text).join(' | ')}`"
      - assert:
          expr: "!offMessages.some((candidate) => candidate.text.trimStart().startsWith('Reasoning:') && !candidate.text.includes('Native reasoning was produced; no summary text was returned.'))"
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
                expr: "String(offRequest?.model ?? '').includes('gpt-5.5')"
                message:
                  expr: "`expected GPT-5.5 off mock request, got ${String(offRequest?.model ?? '')}`"
            - assert:
                expr: "offRequest?.body && !Object.prototype.hasOwnProperty.call(offRequest.body, 'reasoning')"
                message:
                  expr: "`disabled thinking should omit OpenAI reasoning payload, got ${JSON.stringify(offRequest?.body?.reasoning ?? null)}`"
    detailsExpr: "`reasoning ack=${reasoningAck.text}; thinking off=${thinkOffAck.text}; off answer=${offAnswer.text}`"
  - name: switches to medium thinking
    actions:
      - set: thinkMediumCursor
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
              expr: config.maxDirective
      - call: waitForCondition
        saveAs: thinkMediumAck
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(thinkMediumCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && /Thinking level set to medium/i.test(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
    detailsExpr: "`thinking medium=${thinkMediumAck.text}`"
  - name: verifies medium thinking reaches the provider
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
              expr: config.maxPrompt
      - call: waitForCondition
        saveAs: maxAnswer
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(maxCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === config.conversationId && candidate.text.includes(config.maxMarker)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 120000)
      - assert:
          expr: "maxAnswer.text.includes(config.maxMarker)"
          message:
            expr: "`missing max marker near answer: ${recentOutboundSummary(state, 6)}`"
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
                expr: "String(maxRequest?.model ?? '').includes('gpt-5.5')"
                message:
                  expr: "`expected GPT-5.5 mock request, got ${String(maxRequest?.model ?? '')}`"
            - assert:
                expr: "maxRequest?.body?.reasoning?.effort === 'medium'"
                message:
                  expr: "`expected medium OpenAI reasoning payload, got ${JSON.stringify(maxRequest?.body?.reasoning ?? null)}`"
      - if:
          expr: "env.transport.id !== 'qa-channel'"
          then:
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
    detailsExpr: "env.transport.id === 'qa-channel' ? `answer=${maxAnswer.text}; medium reasoning=${env.mock ? String(maxRequest?.body?.reasoning?.effort ?? '') : 'live'}; qa-channel suppresses reasoning delivery` : `answer=${maxAnswer.text}; reasoning=${maxReasoning.text}`"
```
