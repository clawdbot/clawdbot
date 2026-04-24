# Native image generation

```yaml qa-scenario
id: native-image-generation
title: Native image generation
surface: image-generation
coverage:
  primary:
    - media.image-generation
  secondary:
    - tools.native-image-generation
objective: Verify image_generate appears when configured and returns a real saved media artifact.
successCriteria:
  - image_generate appears in the effective tool inventory.
  - Agent triggers native image_generate.
  - Tool output returns a saved MEDIA path and the file exists.
docsRefs:
  - docs/tools/image-generation.md
  - docs/providers/openai.md
codeRefs:
  - src/agents/tools/image-generate-tool.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: flow
  summary: Verify image_generate appears when configured and returns a real saved media artifact.
  config:
    prompt: "Image generation check: generate a QA lighthouse image and summarize it in one short sentence."
    promptSnippet: "Image generation check"
    generatedNeedle: "QA lighthouse"
```

```yaml qa-flow
steps:
  - name: enables image_generate and saves a real media artifact
    actions:
      - call: ensureImageGenerationConfigured
        args:
          - ref: env
      - call: createSession
        saveAs: sessionKey
        args:
          - ref: env
          - Image generation
      - call: readEffectiveTools
        saveAs: tools
        args:
          - ref: env
          - ref: sessionKey
      - assert:
          expr: "tools.has('image_generate')"
          message: image_generate not present after imageGenerationModel patch
      - call: reset
      - set: generationStartedAt
        value:
          expr: Date.now()
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:image-generate
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: liveTurnTimeoutMs(env, 45000)
      - assert:
          expr: "!env.mock || ((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.allInputText ?? '').includes(config.promptSnippet))?.plannedToolName === 'image_generate')"
          message:
            expr: "`expected image_generate, got ${String((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.allInputText ?? '').includes(config.promptSnippet))?.plannedToolName ?? '')}`"
      - call: resolveGeneratedImagePath
        saveAs: generatedPath
        args:
          - env:
              ref: env
            promptSnippet:
              expr: config.promptSnippet
            startedAtMs:
              ref: generationStartedAt
            timeoutMs: 15000
      - assert:
          expr: "typeof generatedPath === 'string' && generatedPath.length > 0"
          message: image generation did not produce a saved media path
    detailsExpr: "`${outbound.text}\\nIMAGE_PATH:${generatedPath}`"
```
