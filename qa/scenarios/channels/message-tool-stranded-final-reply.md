# Message-tool-only private final reply warning

```yaml qa-scenario
id: message-tool-stranded-final-reply
title: Message-tool-only private final reply warning
surface: channel
coverage:
  primary:
    - channels.direct-visible-replies
  secondary:
    - channels.qa-channel
    - tools.message
objective: Reproduce #85714 — under messages.visibleReplies=message_tool a long private final reply that never calls the message tool is kept private (no outbound), and the gateway emits the private-final WARN.
gatewayConfigPatch:
  messages:
    visibleReplies: message_tool
successCriteria:
  - The mock provider returns a long normal final answer and does not plan the message tool.
  - Under message_tool_only delivery the reply is kept private, so the direct conversation receives no outbound message.
  - The gateway logs the private-final WARN from source-reply/private-final.
docsRefs:
  - docs/channels/qa-channel.md
codeRefs:
  - src/auto-reply/reply/agent-runner.ts
  - src/auto-reply/reply/private-message-tool-final.ts
  - src/auto-reply/reply/dispatch-from-config.ts
execution:
  kind: flow
  summary: Send a direct message_tool_only turn whose model reply omits the message tool, and verify a substantive private final warns without outbound delivery.
  config:
    conversationId: qa-stranded-dm
    promptSnippet: qa private final reply warning check
    prompt: "qa private final reply warning check. Reply to me directly in two complete sentences with `QA-STRANDED-85714` in the first sentence and a short explanation in the second sentence. Do NOT call any tool. Do NOT use the message tool."
    expectedMarker: QA-STRANDED-85714
    privateFinalLogNeedle: "source-reply/private-final"
```

```yaml qa-flow
steps:
  - name: warns for substantive private final text when the model omits the message tool
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
      - set: logCursor
        value:
          expr: markGatewayLogCursor()
      - set: requestCountBefore
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).length : 0"
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: alice
            senderName: Alice
            text:
              expr: config.prompt
      - call: waitForNoOutbound
        args:
          - ref: state
          - expr: liveTurnTimeoutMs(env, 30000)
      - set: scenarioRequests
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)) : []"
      - assert:
          expr: "!env.mock || scenarioRequests.length > 0"
          message: expected mock request evidence that the turn actually ran
      - assert:
          expr: "!env.mock || scenarioRequests.every((request) => request.plannedToolName !== 'message')"
          message:
            expr: "`model should not have planned the message tool, saw ${JSON.stringify(scenarioRequests.map((request) => request.plannedToolName ?? null))}`"
      - set: privateFinalLog
        value:
          expr: "String(readGatewayLogs() ?? '').slice(logCursor)"
      - set: privateFinalLine
        value:
          expr: "(privateFinalLog.split('\\n').find((line) => line.includes(config.privateFinalLogNeedle)) ?? '').trim()"
      - assert:
          expr: "privateFinalLog.includes(config.privateFinalLogNeedle)"
          message:
            expr: "`expected the gateway to log ${config.privateFinalLogNeedle} after a substantive private message_tool_only reply, but it was absent`"
    detailsExpr: "`no-outbound private final; WARN logged=${privateFinalLog.includes(config.privateFinalLogNeedle)}; mock requests=${scenarioRequests.length}; gateway log: ${privateFinalLine}`"
```
