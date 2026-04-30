# Kitchen Sink live OpenAI plugin gauntlet

```yaml qa-scenario
id: kitchen-sink-live-openai
title: Kitchen Sink live OpenAI plugin gauntlet
surface: plugins
category: pre-release
coverage:
  primary:
    - plugins.kitchen-sink
  secondary:
    - plugins.lifecycle
    - plugins.plugin-tools
    - models.live-openai
    - gateway.performance
risk: high
objective: Verify the external Kitchen Sink plugin can be installed into a qa-lab gateway, expose its major runtime surfaces, and coexist with a live OpenAI provider turn.
successCriteria:
  - The npm Kitchen Sink package installs, enables, and inspects as loaded.
  - Kitchen Sink command inventory, MCP tool, and channel status work after gateway restart.
  - A live OpenAI turn still completes while the Kitchen Sink plugin is installed.
  - Gateway logs and process metrics are captured and stay under broad anomaly thresholds.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - docs/channels/qa-channel.md
  - docs/plugins/manifest.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/gateway-child.ts
  - scripts/e2e/kitchen-sink-plugin-docker.sh
execution:
  kind: flow
  summary: Install @openclaw/kitchen-sink, restart the gateway, exercise command inventory/tool/channel/OpenAI paths, and record CPU/RSS/log evidence.
  config:
    requiredProviderMode: live-frontier
    requiredProvider: openai
    pluginSpec: npm:@openclaw/kitchen-sink@latest
    pluginId: openclaw-kitchen-sink-fixture
    pluginPersonality: conformance
    adversarialPersonality: adversarial
    channelId: kitchen-sink-channel
    channelAccountId: local
    textProviderId: kitchen-sink-llm
    textModel: kitchen-sink-text-v1
    expectedProviderAny:
      - kitchen-sink-provider
      - kitchen-sink-llm
    expectedToolAny:
      - kitchen_sink_text
      - kitchen_sink_search
      - kitchen_sink_image_job
    maxGatewayCpuCoreRatio: 1.5
    maxGatewayRssMiB: 2048
    agentTurnTimeoutMs: 120000
    outboundTimeoutMs: 60000
    livePrompt: "Kitchen Sink OpenAI marker. Reply exactly: KITCHEN-SINK-OPENAI-OK"
    expectedAdversarialDiagnostics:
      - only bundled plugins can register agent tool result middleware
      - agent harness "kitchen-sink-agent-harness" registration missing required runtime methods
      - channel "kitchen-sink-channel-probe" registration missing required config helpers
      - cli registration missing explicit commands metadata
      - only bundled plugins can register Codex app-server extension factories
      - compaction provider "kitchen-sink-compaction-provider" registration missing summarize
      - context engine registration missing id
      - http route registration missing or invalid auth: /kitchen-sink/http-route
      - "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: kitchen-sink-memory-embedding-provider"
      - memory prompt supplement registration missing builder
```

```yaml qa-flow
steps:
  - name: installs and inspects the Kitchen Sink plugin
    actions:
      - call: runQaCli
        args:
          - ref: env
          - - plugins
            - install
            - expr: config.pluginSpec
          - timeoutMs: 180000
      - call: runQaCli
        args:
          - ref: env
          - - plugins
            - enable
            - expr: config.pluginId
          - timeoutMs: 60000
      - set: configuredPluginPath
        value:
          expr: |-
            (async () => {
              const raw = await fs.readFile(env.gateway.configPath, "utf8").catch(() => "{}");
              const cfg = JSON.parse(raw || "{}");
              cfg.plugins = cfg.plugins || {};
              cfg.plugins.allow = [...new Set([...(cfg.plugins.allow || []), config.pluginId])];
              cfg.plugins.entries = cfg.plugins.entries || {};
              cfg.plugins.entries[config.pluginId] = {
                ...(cfg.plugins.entries[config.pluginId] || {}),
                enabled: true,
                config: {
                  ...(cfg.plugins.entries[config.pluginId]?.config || {}),
                  personality: config.pluginPersonality,
                },
                hooks: {
                  ...(cfg.plugins.entries[config.pluginId]?.hooks || {}),
                  allowConversationAccess: true,
                },
              };
              cfg.channels = {
                ...(cfg.channels || {}),
                [config.channelId]: { enabled: true, token: "kitchen-sink-qa" },
              };
              await fs.writeFile(env.gateway.configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
              return env.gateway.configPath;
            })()
      - call: runQaCli
        saveAs: pluginList
        args:
          - ref: env
          - - plugins
            - list
            - --json
          - json: true
            timeoutMs: 60000
      - call: runQaCli
        saveAs: inspect
        args:
          - ref: env
          - - plugins
            - inspect
            - expr: config.pluginId
            - --json
          - json: true
            timeoutMs: 60000
      - set: inspectFacts
        value:
          expr: |-
            (() => {
              const plugin = inspect.plugin ?? {};
              const namesFromTools = Array.isArray(inspect.tools)
                ? inspect.tools.flatMap((entry) => Array.isArray(entry?.names) ? entry.names : [entry?.name]).filter(Boolean)
                : [];
              const contracts = plugin.contracts && typeof plugin.contracts === "object" ? plugin.contracts : {};
              return {
                id: plugin.id,
                enabled: plugin.enabled,
                status: plugin.status,
                channels: [...new Set([...(plugin.channelIds ?? []), ...(plugin.channels ?? [])])],
                providers: [...new Set([...(plugin.providerIds ?? []), ...(plugin.providers ?? [])])],
                tools: [...new Set([...namesFromTools, ...(contracts.tools ?? [])])],
                diagnostics: [...(pluginList.diagnostics ?? []), ...(inspect.diagnostics ?? [])]
                  .filter((entry) => entry?.level === "error")
                  .map((entry) => String(entry.message ?? "")),
              };
            })()
      - assert:
          expr: "inspectFacts.id === config.pluginId && inspectFacts.enabled === true && inspectFacts.status === 'loaded'"
          message:
            expr: "`Kitchen Sink plugin did not inspect as enabled+loaded: ${JSON.stringify(inspectFacts)}`"
      - assert:
          expr: "inspectFacts.channels.includes(config.channelId)"
          message:
            expr: "`Kitchen Sink channel missing from inspect output: ${JSON.stringify(inspectFacts.channels)}`"
      - assert:
          expr: "config.expectedProviderAny.some((provider) => inspectFacts.providers.includes(provider))"
          message:
            expr: "`Kitchen Sink providers missing from inspect output: ${JSON.stringify(inspectFacts.providers)}`"
      - assert:
          expr: "config.expectedToolAny.some((tool) => inspectFacts.tools.includes(tool))"
          message:
            expr: "`Kitchen Sink tools missing from inspect output: ${JSON.stringify(inspectFacts.tools)}`"
      - assert:
          expr: "inspectFacts.diagnostics.length === 0"
          message:
            expr: "`Kitchen Sink conformance personality emitted diagnostics: ${JSON.stringify(inspectFacts.diagnostics)}`"
    detailsExpr: inspectFacts

  - name: restarts gateway with Kitchen Sink configured
    actions:
      - assert:
          expr: "typeof env.gateway.restartAfterStateMutation === 'function'"
          message: "qa gateway child does not expose restartAfterStateMutation"
      - call: env.gateway.restartAfterStateMutation
        args:
          - lambda:
              async: true
              params: [ctx]
              expr: |-
                (async () => {
                  const raw = await fs.readFile(ctx.configPath, "utf8").catch(() => "{}");
                  const cfg = JSON.parse(raw || "{}");
                  cfg.plugins = cfg.plugins || {};
                  cfg.plugins.allow = [...new Set([...(cfg.plugins.allow || []), config.pluginId])];
                  cfg.plugins.entries = cfg.plugins.entries || {};
                  cfg.plugins.entries[config.pluginId] = {
                    ...(cfg.plugins.entries[config.pluginId] || {}),
                    enabled: true,
                    config: {
                      ...(cfg.plugins.entries[config.pluginId]?.config || {}),
                      personality: config.pluginPersonality,
                    },
                    hooks: {
                      ...(cfg.plugins.entries[config.pluginId]?.hooks || {}),
                      allowConversationAccess: true,
                    },
                  };
                  cfg.channels = {
                    ...(cfg.channels || {}),
                    [config.channelId]: { enabled: true, token: "kitchen-sink-qa" },
                  };
                  await fs.writeFile(ctx.configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
                })()
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 120000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 120000
      - set: perfStartedAtMs
        value:
          expr: "Date.now()"
      - set: cpuStartMs
        value:
          expr: "env.gateway.getProcessCpuMs?.() ?? null"
      - set: rssStartBytes
        value:
          expr: "env.gateway.getProcessRssBytes?.() ?? null"
      - call: env.gateway.call
        saveAs: channelStatus
        args:
          - channels.status
          - probe: true
            timeoutMs: 10000
          - timeoutMs: 15000
      - set: kitchenChannelAccount
        value:
          expr: "(channelStatus.channelAccounts?.[config.channelId] ?? []).find((entry) => entry.accountId === config.channelAccountId) ?? null"
      - assert:
          expr: "kitchenChannelAccount?.running === true && kitchenChannelAccount?.configured === true"
          message:
            expr: "`Kitchen Sink channel did not report running+configured: ${JSON.stringify(kitchenChannelAccount)}`"
    detailsExpr: kitchenChannelAccount

  - name: exercises command inventory and MCP tool surfaces
    actions:
      - call: env.gateway.call
        saveAs: commandList
        args:
          - commands.list
          - agentId: qa
            scope: text
          - timeoutMs: 15000
      - set: pluginCommandNames
        value:
          expr: "(commandList.commands ?? []).filter((entry) => entry.source === 'plugin').map((entry) => entry.name).sort()"
      - assert:
          expr: "pluginCommandNames.includes('kitchen') && pluginCommandNames.includes('kitchen-sink')"
          message:
            expr: "`Kitchen Sink plugin commands missing from commands.list: ${JSON.stringify(pluginCommandNames)}`"
      - call: callPluginToolsMcp
        saveAs: mcpTool
        args:
          - env:
              ref: env
            toolName: kitchen_sink_search
            args:
              query: "kitchen sink qa live openai"
      - set: mcpToolText
        value:
          expr: "JSON.stringify(mcpTool.content ?? mcpTool)"
      - assert:
          expr: "mcpToolText.includes('Kitchen Sink image fixture')"
          message:
            expr: "`Kitchen Sink MCP tool output missed expected fixture: ${mcpToolText.slice(0, 500)}`"
    detailsExpr: "{ pluginCommandNames, mcpToolText: mcpToolText.slice(0, 500) }"

  - name: runs live OpenAI turn with Kitchen Sink loaded
    actions:
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: "`agent:qa:kitchen-sink-openai:${randomUUID().slice(0, 8)}`"
            message:
              expr: config.livePrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, config.agentTurnTimeoutMs)
      - call: waitForOutboundMessage
        saveAs: openaiReply
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes('KITCHEN-SINK-OPENAI-OK')"
          - expr: liveTurnTimeoutMs(env, config.outboundTimeoutMs)
    detailsExpr: "{ openaiReply: openaiReply.text }"

  - name: records gateway CPU RSS and log anomaly evidence
    actions:
      - set: perfEvidence
        value:
          expr: |-
            (() => {
              const cpuStart = typeof vars.cpuStartMs === "number" ? vars.cpuStartMs : null;
              const cpuEnd = env.gateway.getProcessCpuMs?.() ?? null;
              const rssStart = typeof vars.rssStartBytes === "number" ? vars.rssStartBytes : null;
              const rssEnd = env.gateway.getProcessRssBytes?.() ?? null;
              const logs = env.gateway.logs?.() ?? "";
              const deny = [
                /\buncaught exception\b/iu,
                /\bunhandled rejection\b/iu,
                /\bfatal\b/iu,
                /\bpanic\b/iu,
              ];
              const findings = logs
                .split(/\r?\n/u)
                .filter((line) => deny.some((pattern) => pattern.test(line)))
                .slice(0, 10)
                .map((line) => line.replaceAll(env.repoRoot, "<repo>").slice(0, 500));
              const wallMs = Date.now() - Number(vars.perfStartedAtMs ?? Date.now());
              const cpuDeltaMs = cpuStart === null || cpuEnd === null ? null : Math.max(0, cpuEnd - cpuStart);
              const cpuCoreRatio = cpuDeltaMs === null || wallMs <= 0 ? null : Math.round((cpuDeltaMs / wallMs) * 1000) / 1000;
              const rssMiB = rssEnd === null ? null : Math.round((rssEnd / 1024 / 1024) * 10) / 10;
              return {
                wallMs,
                cpuStart,
                cpuEnd,
                cpuDeltaMs,
                cpuCoreRatio,
                rssStartBytes: rssStart,
                rssEndBytes: rssEnd,
                rssMiB,
                logBytes: logs.length,
                findings,
              };
            })()
      - assert:
          expr: "perfEvidence.findings.length === 0"
          message:
            expr: "`Gateway logs contain fatal runtime lines: ${JSON.stringify(perfEvidence.findings)}`"
      - assert:
          expr: "perfEvidence.cpuCoreRatio === null || perfEvidence.cpuCoreRatio <= config.maxGatewayCpuCoreRatio"
          message:
            expr: "`Gateway CPU ratio exceeded Kitchen Sink anomaly threshold: ${JSON.stringify(perfEvidence)}`"
      - assert:
          expr: "perfEvidence.rssMiB === null || perfEvidence.rssMiB <= config.maxGatewayRssMiB"
          message:
            expr: "`Gateway RSS exceeded Kitchen Sink anomaly threshold: ${JSON.stringify(perfEvidence)}`"
    detailsExpr: perfEvidence

  - name: verifies adversarial diagnostics personality
    actions:
      - call: env.gateway.restartAfterStateMutation
        args:
          - lambda:
              async: true
              params: [ctx]
              expr: |-
                (async () => {
                  const raw = await fs.readFile(ctx.configPath, "utf8").catch(() => "{}");
                  const cfg = JSON.parse(raw || "{}");
                  cfg.plugins = cfg.plugins || {};
                  cfg.plugins.allow = [...new Set([...(cfg.plugins.allow || []), config.pluginId])];
                  cfg.plugins.entries = cfg.plugins.entries || {};
                  cfg.plugins.entries[config.pluginId] = {
                    ...(cfg.plugins.entries[config.pluginId] || {}),
                    enabled: true,
                    config: {
                      ...(cfg.plugins.entries[config.pluginId]?.config || {}),
                      personality: config.adversarialPersonality,
                    },
                    hooks: {
                      ...(cfg.plugins.entries[config.pluginId]?.hooks || {}),
                      allowConversationAccess: true,
                    },
                  };
                  await fs.writeFile(ctx.configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
                })()
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 120000
      - call: runQaCli
        saveAs: adversarialInspect
        args:
          - ref: env
          - - plugins
            - inspect
            - expr: config.pluginId
            - --json
          - json: true
            timeoutMs: 60000
      - set: adversarialDiagnostics
        value:
          expr: |-
            (adversarialInspect.diagnostics ?? [])
              .filter((entry) => entry?.level === "error")
              .map((entry) => String(entry.message ?? ""))
      - assert:
          expr: "config.expectedAdversarialDiagnostics.every((message) => adversarialDiagnostics.includes(message))"
          message:
            expr: "`Kitchen Sink adversarial diagnostics missing expected messages: ${JSON.stringify({ expected: config.expectedAdversarialDiagnostics, actual: adversarialDiagnostics })}`"
      - assert:
          expr: "adversarialDiagnostics.every((message) => config.expectedAdversarialDiagnostics.includes(message))"
          message:
            expr: "`Kitchen Sink adversarial diagnostics contained unexpected messages: ${JSON.stringify(adversarialDiagnostics)}`"
    detailsExpr: "{ diagnostics: adversarialDiagnostics }"
```
