# Claude CLI provider capabilities API key

```yaml qa-scenario
id: claude-cli-provider-capabilities
title: Claude CLI provider capabilities API key
surface: model-provider
coverage:
  primary:
    - models.provider-capabilities
  secondary:
    - models.claude-cli
objective: Verify the Claude CLI model-provider lane can use the Anthropic API key path to talk, read an attached image, use bundled MCP tools, and apply workspace skills.
successCriteria:
  - A live-frontier run fails fast unless the selected primary provider is claude-cli.
  - The Claude CLI backend preserves ANTHROPIC_API_KEY for this run instead of using native subscription auth.
  - The agent replies through the Claude CLI provider in a direct chat turn.
  - The agent describes an attached image through the Claude CLI image path.
  - The agent can reach memory via the bundled MCP/tool bridge.
  - The agent sees and follows a workspace skill.
docsRefs:
  - docs/gateway/cli-backends.md
  - docs/tools/skills.md
  - docs/cli/mcp.md
  - docs/tools/index.md
codeRefs:
  - extensions/anthropic/cli-backend.ts
  - src/agents/cli-backends.ts
  - src/mcp/plugin-tools-serve.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Run with `pnpm openclaw qa suite --provider-mode live-frontier --cli-auth-mode api-key --model claude-cli/claude-sonnet-4-6 --alt-model claude-cli/claude-sonnet-4-6 --scenario claude-cli-provider-capabilities`.
  config:
    authMode: api-key
    requiredProvider: claude-cli
    chatPrompt: "Claude CLI provider marker check. Reply exactly: CLAUDE-CLI-CHAT-OK"
    chatExpected: CLAUDE-CLI-CHAT-OK
    imagePrompt: "Image understanding check: describe the top and bottom colors in the attached image in one short sentence."
    imageColorGroups:
      - [red, scarlet, crimson]
      - [blue, azure, teal, cyan, aqua]
    memoryFact: "Hidden Claude CLI MCP fact: the provider bridge codename is ORBIT-9."
    memoryQuery: "provider bridge codename ORBIT-9"
    memoryExpected: ORBIT-9
    memoryPrompt: "Memory tools check: use the available memory search MCP/tool bridge to find the hidden provider bridge codename stored only in memory. Reply with the codename."
    memoryPromptSnippet: "Memory tools check"
    skillName: qa-claude-cli-skill
    skillExpected: VISIBLE-SKILL-OK
    skillBody: |-
      ---
      name: qa-claude-cli-skill
      description: Claude CLI QA skill marker
      ---
      When the user asks for the Claude CLI skill marker exactly, or explicitly asks you to use qa-claude-cli-skill, reply with exactly: VISIBLE-SKILL-OK
    skillPrompt: "Use qa-claude-cli-skill now. Reply exactly with the visible skill marker and nothing else."
```

```yaml qa-flow
steps:
  - name: confirms the selected live provider and Claude CLI auth mode
    actions:
      - set: selected
        value:
          expr: splitModelRef(env.primaryModel)
      - set: preserveEnv
        value:
          expr: "String(env.gateway.runtimeEnv.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV ?? '')"
      - assert:
          expr: "env.providerMode !== 'live-frontier' || selected?.provider === config.requiredProvider"
          message:
            expr: "`expected live primary provider ${config.requiredProvider}, got ${env.primaryModel}`"
      - assert:
          expr: "env.providerMode !== 'live-frontier' || env.gateway.runtimeEnv.OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE === config.authMode"
          message:
            expr: "`expected Claude CLI auth mode ${config.authMode}, got ${env.gateway.runtimeEnv.OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE ?? 'unset'}`"
      - assert:
          expr: "env.providerMode !== 'live-frontier' || preserveEnv.includes('ANTHROPIC_API_KEY')"
          message:
            expr: "`expected ANTHROPIC_API_KEY to be preserved for Claude CLI API-key QA mode, got ${preserveEnv}`"
    detailsExpr: "env.providerMode === 'live-frontier' ? `provider=${selected?.provider} model=${selected?.model} auth=${env.gateway.runtimeEnv.OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE} preserve=${preserveEnv}` : `mock-compatible provider=${selected?.provider}`"
  - name: talks through the selected provider
    actions:
      - call: reset
      - set: selected
        value:
          expr: splitModelRef(env.primaryModel)
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:claude-cli-chat
            message:
              expr: config.chatPrompt
            provider:
              expr: selected?.provider
            model:
              expr: selected?.model
            timeoutMs:
              expr: resolveQaLiveTurnTimeoutMs(env, 45000, env.primaryModel)
      - call: waitForOutboundMessage
        saveAs: chatOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: resolveQaLiveTurnTimeoutMs(env, 20000, env.primaryModel)
      - assert:
          expr: "chatOutbound.text.includes(config.chatExpected)"
          message:
            expr: "`chat marker missing: ${chatOutbound.text}`"
    detailsExpr: chatOutbound.text
  - name: describes an attached image through the selected provider
    actions:
      - call: reset
      - set: selected
        value:
          expr: splitModelRef(env.primaryModel)
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:claude-cli-image
            message:
              expr: config.imagePrompt
            provider:
              expr: selected?.provider
            model:
              expr: selected?.model
            attachments:
              - mimeType: image/png
                fileName: claude-cli-red-top-blue-bottom.png
                content:
                  expr: imageUnderstandingValidPngBase64
            timeoutMs:
              expr: resolveQaLiveTurnTimeoutMs(env, 60000, env.primaryModel)
      - call: waitForOutboundMessage
        saveAs: imageOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: resolveQaLiveTurnTimeoutMs(env, 30000, env.primaryModel)
      - assert:
          expr: "config.imageColorGroups.every((group) => group.some((color) => normalizeLowercaseStringOrEmpty(imageOutbound.text).includes(color)))"
          message:
            expr: "`missing expected image colors: ${imageOutbound.text}`"
      - assert:
          expr: "!env.mock || (((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.prompt ?? '').includes('Image understanding check'))?.imageInputCount ?? 0) >= 1)"
          message: expected image input to reach mock provider
    detailsExpr: imageOutbound.text
  - name: reaches memory through the MCP/tool bridge
    actions:
      - call: reset
      - call: fs.writeFile
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
          - expr: "`${config.memoryFact}\\n`"
          - utf8
      - call: forceMemoryIndex
        args:
          - env:
              ref: env
            query:
              expr: config.memoryQuery
            expectedNeedle:
              expr: config.memoryExpected
      - call: createSession
        saveAs: mcpSessionKey
        args:
          - ref: env
          - Claude CLI MCP bridge
      - call: readEffectiveTools
        saveAs: mcpTools
        args:
          - ref: env
          - ref: mcpSessionKey
      - assert:
          expr: "mcpTools.has('memory_search')"
          message: memory_search missing from effective tools before MCP bridge check
      - set: selected
        value:
          expr: splitModelRef(env.primaryModel)
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: mcpSessionKey
            message:
              expr: config.memoryPrompt
            provider:
              expr: selected?.provider
            model:
              expr: selected?.model
            timeoutMs:
              expr: resolveQaLiveTurnTimeoutMs(env, 90000, env.primaryModel)
      - call: waitForOutboundMessage
        saveAs: mcpOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: resolveQaLiveTurnTimeoutMs(env, 45000, env.primaryModel)
      - assert:
          expr: "mcpOutbound.text.includes(config.memoryExpected)"
          message:
            expr: "`MCP memory result missing ${config.memoryExpected}: ${mcpOutbound.text}`"
      - assert:
          expr: "!env.mock || (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).filter((request) => String(request.allInputText ?? '').includes(config.memoryPromptSnippet)).some((request) => request.plannedToolName === 'memory_search')"
          message: expected mock model to plan memory_search for MCP bridge prompt
    detailsExpr: mcpOutbound.text
  - name: applies a workspace skill through the selected provider
    actions:
      - call: reset
      - call: writeWorkspaceSkill
        args:
          - env:
              ref: env
            name:
              expr: config.skillName
            body:
              expr: config.skillBody
      - call: waitForCondition
        args:
          - lambda:
              async: true
              expr: "((await readSkillStatus(env)).find((skill) => skill.name === config.skillName)?.eligible ? true : undefined)"
          - 15000
          - 200
      - set: selected
        value:
          expr: splitModelRef(env.primaryModel)
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:claude-cli-skill
            message:
              expr: config.skillPrompt
            provider:
              expr: selected?.provider
            model:
              expr: selected?.model
            timeoutMs:
              expr: resolveQaLiveTurnTimeoutMs(env, 60000, env.primaryModel)
      - call: waitForOutboundMessage
        saveAs: skillOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator'"
          - expr: resolveQaLiveTurnTimeoutMs(env, 30000, env.primaryModel)
      - assert:
          expr: "skillOutbound.text.includes(config.skillExpected)"
          message:
            expr: "`skill marker missing: ${skillOutbound.text}`"
    detailsExpr: skillOutbound.text
```
