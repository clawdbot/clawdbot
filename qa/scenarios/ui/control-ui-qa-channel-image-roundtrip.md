# Control UI plus qa-channel image roundtrip

```yaml qa-scenario
id: control-ui-qa-channel-image-roundtrip
title: Control UI plus qa-channel image roundtrip
surface: control-ui
coverage:
  primary:
    - ui.control
  secondary:
    - media.image-understanding
    - channels.qa-channel
objective: Verify the embedded Control UI can observe a qa-channel-backed session while the fake channel injects text and image turns that the agent answers correctly.
successCriteria:
  - Control UI opens directly on the target qa-channel session.
  - A text prompt delivered through qa-channel produces a correct outbound reply.
  - A later qa-channel image message produces a correct image-aware reply.
  - The Control UI transcript shows both transport-side prompts and both final answers.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/scenario-runtime-api.ts
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/web-runtime.ts
  - ui/src/ui/views/chat.ts
gatewayRuntime:
  forwardHostHome: true
execution:
  kind: flow
  summary: Open the Control UI on a qa-channel session with the generic QA web driver, inject text and image turns through qa-channel, and verify the replies in both the transport log and the UI transcript.
  config:
    conversationId: control-ui-e2e
    textPrompt: "Control UI bridge check. Marker exact marker: `ui bridge armed`"
    uiExpectedNeedle: ui bridge armed
    imagePrompt: "Image understanding check: describe the top and bottom colors in the attached image in one short sentence."
    imagePromptNeedle: image understanding check
    requiredColorGroups:
      - [red, scarlet, crimson]
      - [blue, azure, teal, cyan, aqua]
```

```yaml qa-flow
steps:
  - name: opens control ui on the qa-channel-backed session
    actions:
      - call: reset
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - expr: liveTurnTimeoutMs(env, 60000)
      - call: waitForQaChannelReady
        args:
          - ref: env
          - expr: liveTurnTimeoutMs(env, 60000)
      - call: fetchJson
        saveAs: bootstrap
        args:
          - expr: "`${lab.baseUrl}/api/bootstrap`"
      - assert:
          expr: "Boolean(bootstrap.controlUiEmbeddedUrl)"
          message: qa-lab bootstrap did not expose controlUiEmbeddedUrl
      - set: uiSessionKey
        value:
          expr: "buildAgentSessionKey({ agentId: env.cfg.agents?.list?.find((agent) => agent.default)?.id ?? env.cfg.agents?.list?.[0]?.id ?? 'main', channel: 'qa-channel', accountId: 'default', peer: { kind: 'direct', id: config.conversationId }, dmScope: env.cfg.session?.dmScope, identityLinks: env.cfg.session?.identityLinks })"
      - set: controlUiChatUrl
        value:
          expr: "(() => { const url = new URL(String(bootstrap.controlUiEmbeddedUrl)); url.pathname = `${url.pathname.replace(/\\/$/, '')}/chat`; url.searchParams.set('session', uiSessionKey); return url.toString(); })()"
      - call: webOpenPage
        saveAs: uiTab
        args:
          - url:
              ref: controlUiChatUrl
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - set: uiPageId
        value:
          expr: "uiTab.pageId"
      - call: webWait
        args:
          - pageId:
              ref: uiPageId
            selector: textarea
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForCondition
        saveAs: uiReadySnapshot
        args:
          - lambda:
              async: true
              expr: "await (async () => { const snapshot = await webSnapshot({ pageId: uiPageId, maxChars: 12000, timeoutMs: liveTurnTimeoutMs(env, 30000) }); const text = normalizeLowercaseStringOrEmpty(snapshot.text); return text.includes('ready to chat') ? snapshot : undefined; })()"
          - expr: liveTurnTimeoutMs(env, 45000)
          - 500
      - assert:
          expr: "Boolean(uiPageId)"
          message: control ui page was not available
    detailsExpr: "uiReadySnapshot.text"
  - name: text injected through qa-channel gets a correct transport reply
    actions:
      - set: firstInboundStartIndex
        value:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'inbound').length"
      - set: firstOutboundStartIndex
        value:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound').length"
      - call: injectInboundMessage
        args:
          - accountId: default
            conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId:
              expr: config.conversationId
            senderName: Control UI QA
            text:
              expr: config.textPrompt
      - call: waitForOutboundMessage
        saveAs: uiOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.conversationId && normalizeLowercaseStringOrEmpty(candidate.text).includes(config.uiExpectedNeedle)"
          - expr: liveTurnTimeoutMs(env, 45000)
          - sinceIndex:
              ref: firstOutboundStartIndex
      - call: readRawQaSessionStore
        saveAs: rawSessionStore
        args:
          - ref: env
      - set: rawSessionStoreKeys
        value:
          expr: "Object.keys(rawSessionStore)"
    detailsExpr: "`${uiOutbound.text}\\nSTORE:${JSON.stringify(rawSessionStoreKeys)}`"
  - name: text injected through qa-channel renders in a fresh control ui load
    actions:
      - call: webOpenPage
        saveAs: uiAckTab
        args:
          - url:
              ref: controlUiChatUrl
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - set: uiAckPageId
        value:
          expr: "uiAckTab.pageId"
      - call: webWait
        args:
          - pageId:
              ref: uiAckPageId
            selector: textarea
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - try:
          actions:
            - call: waitForCondition
              saveAs: uiAckSnapshot
              args:
                - lambda:
                    async: true
                    expr: "await (async () => { const snapshot = await webSnapshot({ pageId: uiAckPageId, maxChars: 12000, timeoutMs: liveTurnTimeoutMs(env, 30000) }); const text = normalizeLowercaseStringOrEmpty(snapshot.text); return text.includes(config.uiExpectedNeedle) && text.includes('control ui bridge check') ? snapshot : undefined; })()"
                - expr: liveTurnTimeoutMs(env, 45000)
                - 500
          catch:
            - call: webSnapshot
              saveAs: uiAckFailureSnapshot
              args:
                - pageId:
                    ref: uiAckPageId
                  maxChars: 12000
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 15000)
            - call: webEvaluate
              saveAs: uiAckFailureState
              args:
                - pageId:
                    ref: uiAckPageId
                  expression: "(() => { const app = document.querySelector('openclaw-app'); return app ? { sessionKey: app.sessionKey, settingsSessionKey: app.settings?.sessionKey, lastActiveSessionKey: app.settings?.lastActiveSessionKey, chatMessages: Array.isArray(app.chatMessages) ? app.chatMessages.length : null, chatLoading: app.chatLoading, lastError: app.lastError, connected: app.connected } : null; })()"
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 15000)
            - throw:
                expr: "`control ui text transcript missing after fresh load. state=${JSON.stringify(uiAckFailureState)} snapshot: ${uiAckFailureSnapshot.text}`"
    detailsExpr: "uiAckSnapshot.text"
  - name: image injected through qa-channel gets a correct transport reply
    actions:
      - set: secondOutboundStartIndex
        value:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound').length"
      - call: injectInboundMessage
        args:
          - accountId: default
            conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId:
              expr: config.conversationId
            senderName: Control UI QA
            text:
              expr: config.imagePrompt
            attachments:
              - kind: image
                mimeType: image/png
                fileName: red-top-blue-bottom.png
                altText: red on top blue on bottom
                contentBase64:
                  expr: imageUnderstandingValidPngBase64
      - call: waitForOutboundMessage
        saveAs: imageOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.conversationId && config.requiredColorGroups.every((group) => group.some((color) => normalizeLowercaseStringOrEmpty(candidate.text).includes(color)))"
          - expr: liveTurnTimeoutMs(env, 45000)
          - sinceIndex:
              ref: secondOutboundStartIndex
      - set: missingColorGroup
        value:
          expr: "config.requiredColorGroups.find((group) => !group.some((color) => normalizeLowercaseStringOrEmpty(imageOutbound.text).includes(color)))"
      - assert:
          expr: "!missingColorGroup"
          message:
            expr: "`missing expected colors in image reply: ${imageOutbound.text}`"
    detailsExpr: "imageOutbound.text"
  - name: image injected through qa-channel renders in a fresh control ui load
    actions:
      - call: webOpenPage
        saveAs: uiImageTab
        args:
          - url:
              ref: controlUiChatUrl
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 60000)
      - set: uiImagePageId
        value:
          expr: "uiImageTab.pageId"
      - call: webWait
        args:
          - pageId:
              ref: uiImagePageId
            selector: textarea
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - try:
          actions:
            - call: waitForCondition
              saveAs: uiImageSnapshot
              args:
                - lambda:
                    async: true
                    expr: "await (async () => { const snapshot = await webSnapshot({ pageId: uiImagePageId, maxChars: 12000, timeoutMs: liveTurnTimeoutMs(env, 30000) }); const text = normalizeLowercaseStringOrEmpty(snapshot.text); const hasPrompt = text.includes(config.imagePromptNeedle); const hasColors = config.requiredColorGroups.every((group) => group.some((color) => text.includes(color))); return hasPrompt && hasColors ? snapshot : undefined; })()"
                - expr: liveTurnTimeoutMs(env, 45000)
                - 500
          catch:
            - call: webSnapshot
              saveAs: uiImageFailureSnapshot
              args:
                - pageId:
                    ref: uiImagePageId
                  maxChars: 12000
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 15000)
            - call: webEvaluate
              saveAs: uiImageFailureState
              args:
                - pageId:
                    ref: uiImagePageId
                  expression: "(() => { const app = document.querySelector('openclaw-app'); return app ? { sessionKey: app.sessionKey, settingsSessionKey: app.settings?.sessionKey, lastActiveSessionKey: app.settings?.lastActiveSessionKey, chatMessages: Array.isArray(app.chatMessages) ? app.chatMessages.length : null, chatLoading: app.chatLoading, lastError: app.lastError, connected: app.connected } : null; })()"
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 15000)
            - throw:
                expr: "`control ui image transcript missing after fresh load. state=${JSON.stringify(uiImageFailureState)} snapshot: ${uiImageFailureSnapshot.text}`"
    detailsExpr: "uiImageSnapshot.text"
```
