# Group visible reply via message tool

```yaml qa-scenario
id: group-visible-reply-tool
title: Group visible reply via message tool
surface: channel
coverage:
  primary:
    - channels.group-visible-replies
  secondary:
    - channels.qa-channel
    - tools.message
objective: Verify a group-sourced QA channel turn replies visibly through message(action=send) in the same room.
gatewayConfigPatch:
  messages:
    groupChat:
      visibleReplies: message_tool
successCriteria:
  - Agent receives a synthetic shared-room turn.
  - Mock provider calls the shared message tool instead of relying on final-answer delivery.
  - The visible reply lands once in the same group transcript.
docsRefs:
  - docs/channels/groups.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-channel/src/inbound.ts
  - extensions/qa-channel/src/outbound.ts
  - src/auto-reply/reply/dispatch-from-config.ts
execution:
  kind: flow
  summary: Send a mentioned group message and verify visible output uses the message tool in the source group.
  config:
    conversationId: qa-visible-tool-room
    promptSnippet: qa group visible reply tool check
    prompt: "@openclaw qa group visible reply tool check. Use the visible room reply path. exact marker: `QA-GROUP-TOOL-OK`"
    expectedMarker: QA-GROUP-TOOL-OK
```

```yaml qa-flow
steps:
  - name: posts visible room output through message tool
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
              title: QA Visible Tool Room
            senderId: alice
            senderName: Alice
            text:
              expr: config.prompt
      - call: waitForCondition
        args:
          - lambda:
              async: true
              params: []
              expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore).find((request) => String(request.allInputText ?? '').includes(config.promptSnippet)) : true"
          - expr: liveTurnTimeoutMs(env, 180000)
      - set: scenarioRequests
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)) : []"
      - assert:
          expr: "!env.mock || scenarioRequests.some((request) => request.plannedToolName === 'message' && request.plannedToolArgs?.action === 'send' && request.plannedToolArgs?.message === config.expectedMarker)"
          message:
            expr: "`expected message(action=send) with marker, saw ${JSON.stringify(scenarioRequests.map((request) => ({ plannedToolName: request.plannedToolName ?? null, plannedToolArgs: request.plannedToolArgs ?? null, toolOutput: request.toolOutput ?? '', tools: Array.isArray(request.body?.tools) ? request.body.tools.map((tool) => tool?.name ?? tool?.function?.name ?? tool?.type ?? null).filter(Boolean).slice(0, 25) : [] })))} `"
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
            expr: "`expected exactly one visible group reply, saw ${matchingOutbound.length}`"
    detailsExpr: "`${outbound.conversation.kind}:${outbound.conversation.id}:${outbound.text}`"
```
