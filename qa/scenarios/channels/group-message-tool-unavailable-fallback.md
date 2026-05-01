# Group fallback when message tool is unavailable

```yaml qa-scenario
id: group-message-tool-unavailable-fallback
title: Group fallback when message tool is unavailable
surface: channel
coverage:
  primary:
    - channels.group-visible-replies
  secondary:
    - channels.qa-channel
    - tools.message
objective: Reproduce the group-visible-reply bug class where message_tool mode selected tool-only delivery even though group tool policy removed the message tool.
gatewayConfigPatch:
  messages:
    groupChat:
      visibleReplies: message_tool
  channels:
    qa-channel:
      groups:
        qa-fallback-room:
          tools:
            allow:
              - read
successCriteria:
  - The group policy removes the message tool for this room.
  - The mock provider returns a normal final answer with the marker.
  - OpenClaw falls back to automatic delivery and posts the marker to the same group.
docsRefs:
  - docs/channels/groups.md
  - docs/channels/qa-channel.md
codeRefs:
  - src/auto-reply/reply/dispatch-from-config.ts
  - extensions/qa-channel/src/inbound.ts
execution:
  kind: flow
  summary: Verify message_tool visible replies degrade to automatic delivery when the active group policy removes message.
  config:
    conversationId: qa-fallback-room
    promptSnippet: qa group message unavailable fallback check
    prompt: "@openclaw qa group message unavailable fallback check. exact marker: `QA-GROUP-FALLBACK-OK`"
    expectedMarker: QA-GROUP-FALLBACK-OK
```

```yaml qa-flow
steps:
  - name: falls back to final-answer delivery when message is not available
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
      - set: requestCountBefore
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).length : 0"
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: group
              title: QA Fallback Room
            senderId: alice
            senderName: Alice
            text:
              expr: config.prompt
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.conversationId && candidate.conversation.kind === 'group' && !candidate.threadId && candidate.text.includes(config.expectedMarker)"
          - expr: liveTurnTimeoutMs(env, 180000)
      - set: matchingOutbound
        value:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound' && message.conversation.id === config.conversationId && message.conversation.kind === 'group' && String(message.text ?? '').includes(config.expectedMarker))"
      - assert:
          expr: matchingOutbound.length === 1
          message:
            expr: "`expected exactly one fallback group reply, saw ${matchingOutbound.length}`"
      - set: scenarioRequests
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)) : []"
      - assert:
          expr: "!env.mock || scenarioRequests.length > 0"
          message: expected mock request evidence for fallback scenario
      - assert:
          expr: "!env.mock || scenarioRequests.every((request) => request.plannedToolName !== 'message')"
          message:
            expr: "`message tool should not be planned when group policy removes it, saw ${JSON.stringify(scenarioRequests.map((request) => request.plannedToolName ?? null))}`"
    detailsExpr: "`${outbound.conversation.kind}:${outbound.conversation.id}:${outbound.text}`"
```
