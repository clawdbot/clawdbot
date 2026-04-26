# Config restart capability flip

```yaml qa-scenario
id: config-restart-capability-flip
title: Config restart capability flip
surface: config
coverage:
  primary:
    - config.restart-apply
  secondary:
    - plugins.capabilities
objective: Verify a restart-triggering config change flips capability inventory and the same session successfully uses the newly restored tool after wake-up.
successCriteria:
  - Capability is absent before the restart-triggering patch.
  - Restart sentinel wakes the same session back up after config patch.
  - The restored capability appears in tools.effective and works in the follow-up turn.
docsRefs:
  - docs/gateway/configuration.md
  - docs/gateway/protocol.md
  - docs/tools/image-generation.md
codeRefs:
  - src/gateway/server-methods/config.ts
  - src/gateway/server-restart-sentinel.ts
  - src/gateway/server-methods/tools-effective.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify a restart-triggering config change flips capability inventory and the same session successfully uses the newly restored tool after wake-up.
  config:
    setupPrompt: "Capability flip setup: acknowledge this setup so restart wake-up has a route."
    imagePrompt: "Capability flip image check: generate a QA lighthouse image in this turn right now. Do not acknowledge first, do not promise future work, and do not stop before using image_generate. Final reply must include the MEDIA path."
    imagePromptSnippet: "Capability flip image check"
    deniedTool: image_generate
```

```yaml qa-flow
steps:
  - name: restores image_generate after restart and uses it in the same session
    actions:
      - call: ensureImageGenerationConfigured
        args:
          - ref: env
      - call: readConfigSnapshot
        saveAs: original
        args:
          - ref: env
      - set: originalTools
        value:
          expr: "original.config.tools && typeof original.config.tools === 'object' ? original.config.tools : null"
      - set: originalToolsDeny
        value:
          expr: "originalTools ? (Object.prototype.hasOwnProperty.call(originalTools, 'deny') ? structuredClone(originalTools.deny) : undefined) : undefined"
      - set: originalImageGenerationModelPrimary
        value:
          expr: "original.config.agents?.defaults?.imageGenerationModel?.primary ?? null"
      - set: denied
        value:
          expr: "Array.isArray(originalToolsDeny) ? originalToolsDeny.map((entry) => String(entry)) : []"
      - set: deniedWithImage
        value:
          expr: "denied.includes(config.deniedTool) ? denied : [...denied, config.deniedTool]"
      - set: sessionKey
        value: agent:qa:capability-flip
      - call: createSession
        args:
          - ref: env
          - Capability flip
          - ref: sessionKey
      - try:
          actions:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    tools:
                      deny:
                        ref: deniedWithImage
            - call: waitForGatewayHealthy
              args:
                - ref: env
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey:
                    ref: sessionKey
                  message:
                    expr: config.setupPrompt
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 30000)
            - call: readEffectiveTools
              saveAs: beforeTools
              args:
                - ref: env
                - ref: sessionKey
            - assert:
                expr: "!beforeTools.has(config.deniedTool)"
                message:
                  expr: "`${config.deniedTool} still present before capability flip`"
            - set: wakeMarker
              value:
                expr: "`QA-CAPABILITY-${randomUUID().slice(0, 8)}`"
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    tools:
                      deny:
                        expr: "originalToolsDeny === undefined ? null : originalToolsDeny"
                    agents:
                      defaults:
                        imageGenerationModel:
                          primary:
                            ref: originalImageGenerationModelPrimary
                  sessionKey:
                    ref: sessionKey
                  note:
                    ref: wakeMarker
            - call: waitForGatewayHealthy
              args:
                - ref: env
                - 60000
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
            - call: waitForCondition
              saveAs: afterTools
              args:
                - lambda:
                    async: true
                    expr: "(() => readEffectiveTools(env, sessionKey).then((tools) => (tools.has('image_generate') ? tools : undefined)))()"
                - expr: liveTurnTimeoutMs(env, 45000)
                - 500
            - set: imageStartedAtMs
              value:
                expr: "Date.now()"
            - set: mediaPath
              value: ""
            - set: imageReplyText
              value: ""
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey:
                    ref: sessionKey
                  message:
                    expr: config.imagePrompt
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 45000)
            - try:
                actions:
                  - call: resolveGeneratedImagePath
                    saveAs: mediaPath
                    args:
                      - env:
                          ref: env
                        promptSnippet:
                          expr: config.imagePromptSnippet
                        startedAtMs:
                          ref: imageStartedAtMs
                        timeoutMs:
                          expr: liveTurnTimeoutMs(env, 15000)
                catch:
                  - set: mediaPath
                    value: ""
            - if:
                expr: "!mediaPath"
                then:
                  - call: waitForOutboundMessage
                    saveAs: imageReply
                    args:
                      - ref: state
                      - lambda:
                          params: [candidate]
                          expr: "candidate.conversation.id === 'qa-operator' && (String(candidate.text ?? '').includes('MEDIA:') || /media failed|image generation failed/i.test(String(candidate.text ?? '')))"
                      - expr: liveTurnTimeoutMs(env, 45000)
                  - set: imageReplyText
                    value:
                      expr: "String(imageReply.text ?? '')"
                else:
                  - set: imageReplyText
                    value:
                      expr: "`MEDIA:${mediaPath}`"
            - set: imageReplyLower
              value:
                expr: "imageReplyText.toLowerCase()"
            - assert:
                expr: "Boolean(mediaPath) || (!env.mock && /media failed|image generation failed/.test(imageReplyLower))"
                message:
                  expr: "`expected restored ${config.deniedTool} to either produce media or, in live mode only, surface a provider-side image failure; got ${imageReplyText}`"
            # Tool-call assertion (criterion 2 of the parity completion
            # gate in #64227): the restored `image_generate` capability
            # must have actually fired as a real tool call. Without this
            # assertion, a prose reply that just mentions a MEDIA path
            # could satisfy the scenario, so strengthen it by requiring
            # the mock to have recorded `plannedToolName: "image_generate"`
            # against a post-restart request. The `!env.mock || ...`
            # guard means this check only runs in mock mode (where
            # `/debug/requests` is available); live-frontier runs skip
            # it and still pass the rest of the scenario.
            - assert:
                expr: "!env.mock || [...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))].some((request) => String(request.allInputText ?? '').toLowerCase().includes('capability flip image check') && request.plannedToolName === 'image_generate')"
                message:
                  expr: "`expected image_generate tool call during capability flip scenario, saw plannedToolNames=${JSON.stringify([...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))].filter((request) => String(request.allInputText ?? '').toLowerCase().includes('capability flip image check')).map((request) => request.plannedToolName ?? null))}`"
          finally:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    tools:
                      deny:
                        expr: "originalToolsDeny === undefined ? null : originalToolsDeny"
            - call: waitForGatewayHealthy
              args:
                - ref: env
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
    detailsExpr: "`${wakeMarker}\\n${config.deniedTool}=${String(afterTools.has(config.deniedTool))}\\n${mediaPath ? `MEDIA:${mediaPath}` : imageReplyText}`"
```
