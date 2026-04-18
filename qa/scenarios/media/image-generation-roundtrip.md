# Image generation roundtrip

```yaml qa-scenario
id: image-generation-roundtrip
title: Image generation roundtrip
surface: image-generation
coverage:
  primary:
    - media.image-generation
  secondary:
    - channels.qa-channel
objective: Verify a generated image is saved as media, reattached on the next turn, and described correctly through the vision path.
successCriteria:
  - image_generate produces a saved MEDIA artifact.
  - The generated artifact is reattached on a follow-up turn.
  - The follow-up vision answer describes the generated scene rather than a generic attachment placeholder.
docsRefs:
  - docs/tools/image-generation.md
  - docs/help/testing.md
codeRefs:
  - src/agents/tools/image-generate-tool.ts
  - src/gateway/chat-attachments.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: flow
  summary: Verify a generated image is saved as media, reattached on the next turn, and described correctly through the vision path.
  config:
    generatePrompt: "Image generation check: generate a QA lighthouse image and summarize it in one short sentence."
    generatePromptSnippet: "Image generation check"
    inspectPrompt: "Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence."
    expectedNeedle: "lighthouse"
```

```yaml qa-flow
steps:
  - name: reattaches the generated media artifact on the follow-up turn
    actions:
      - call: ensureImageGenerationConfigured
        args:
          - ref: env
      - call: createSession
        args:
          - ref: env
          - Image roundtrip
          - agent:qa:image-roundtrip
      - call: reset
      - set: generatedStartedAtMs
        value:
          expr: Date.now()
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:image-roundtrip
            message:
              expr: config.generatePrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: resolveGeneratedImagePath
        saveAs: mediaPath
        args:
          - env:
              ref: env
            promptSnippet:
              expr: config.generatePromptSnippet
            startedAtMs:
              ref: generatedStartedAtMs
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: fs.readFile
        saveAs: imageBuffer
        args:
          - ref: mediaPath
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:image-roundtrip
            message:
              expr: config.inspectPrompt
            attachments:
              - mimeType: image/png
                fileName:
                  expr: path.basename(mediaPath)
                content:
                  expr: imageBuffer.toString('base64')
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && normalizeLowercaseStringOrEmpty(candidate.text).includes(normalizeLowercaseStringOrEmpty(config.expectedNeedle))).at(-1)"
          - expr: liveTurnTimeoutMs(env, 45000)
      - assert:
          expr: "!env.mock || Boolean((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => request.plannedToolName === 'image_generate' && String(request.prompt ?? '').includes(config.generatePromptSnippet)))"
          message: expected image_generate call before roundtrip inspection
      - assert:
          expr: "!env.mock || (((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.prompt ?? '').includes(config.inspectPrompt))?.imageInputCount ?? 0) >= 1)"
          message: expected generated artifact to be reattached on follow-up turn
    detailsExpr: "`MEDIA:${mediaPath}\\n${outbound.text}`"
```
