// Plugin compatibility registry exposes known plugin compatibility metadata to doctor/update flows.
import type { PluginCompatRecord } from "./types.js";

type DeprecatedPluginSdkSubpathSeed = Pick<
  PluginCompatRecord,
  "code" | "owner" | "removeAfter" | "replacement"
> & {
  subpath: string;
};

const DEPRECATED_PLUGIN_SDK_SUBPATH_SEEDS = [
  {
    code: "plugin-sdk-channel-streaming-subpath",
    subpath: "channel-streaming",
    owner: "channel",
    removeAfter: "2026-08-15",
    replacement: "`openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-config-runtime-subpath",
    subpath: "config-runtime",
    owner: "config",
    removeAfter: "2026-09-01",
    replacement:
      "`api.pluginConfig`, `openclaw/plugin-sdk/config-mutation`, `openclaw/plugin-sdk/runtime-config-snapshot`, and `openclaw/plugin-sdk/config-contracts`",
  },
  {
    code: "plugin-sdk-inbound-reply-dispatch-subpath",
    subpath: "inbound-reply-dispatch",
    owner: "channel",
    removeAfter: "2026-08-15",
    replacement: "`openclaw/plugin-sdk/channel-inbound` and `openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-channel-reply-pipeline-subpath",
    subpath: "channel-reply-pipeline",
    owner: "channel",
    removeAfter: "2026-09-01",
    replacement: "`openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-infra-runtime-subpath",
    subpath: "infra-runtime",
    owner: "sdk",
    removeAfter: "2026-09-01",
    replacement:
      "focused subpaths including `openclaw/plugin-sdk/delivery-queue-runtime`, `openclaw/plugin-sdk/diagnostic-runtime`, `openclaw/plugin-sdk/error-runtime`, `openclaw/plugin-sdk/exec-approvals-runtime`, `openclaw/plugin-sdk/fetch-runtime`, and `openclaw/plugin-sdk/ssrf-runtime`",
  },
  {
    code: "plugin-sdk-text-runtime-subpath",
    subpath: "text-runtime",
    owner: "sdk",
    removeAfter: "2026-08-15",
    replacement:
      "`openclaw/plugin-sdk/logging-core`, `openclaw/plugin-sdk/text-chunking`, `openclaw/plugin-sdk/text-utility-runtime`, and `openclaw/plugin-sdk/string-coerce-runtime`",
  },
  {
    code: "plugin-sdk-channel-secret-runtime-subpath",
    subpath: "channel-secret-runtime",
    owner: "channel",
    removeAfter: "2026-08-15",
    replacement:
      "`openclaw/plugin-sdk/channel-secret-basic-runtime` and `openclaw/plugin-sdk/channel-secret-tts-runtime`",
  },
  {
    code: "plugin-sdk-agent-config-primitives-subpath",
    subpath: "agent-config-primitives",
    owner: "config",
    removeAfter: "2026-08-15",
    replacement: "`openclaw/plugin-sdk/channel-config-schema`",
  },
  {
    code: "plugin-sdk-matrix-subpath",
    subpath: "matrix",
    owner: "channel",
    removeAfter: "2026-08-15",
    replacement: "`openclaw/plugin-sdk/run-command`",
  },
  {
    code: "plugin-sdk-channel-logging-subpath",
    subpath: "channel-logging",
    owner: "channel",
    removeAfter: "2026-08-15",
    replacement: "`openclaw/plugin-sdk/channel-inbound` and `openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-channel-lifecycle-subpath",
    subpath: "channel-lifecycle",
    owner: "channel",
    removeAfter: "2026-09-01",
    replacement: "`openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-channel-message-subpath",
    subpath: "channel-message",
    owner: "channel",
    removeAfter: "2026-09-01",
    replacement: "`openclaw/plugin-sdk/channel-outbound` and `openclaw/plugin-sdk/channel-inbound`",
  },
  {
    code: "plugin-sdk-group-access-subpath",
    subpath: "group-access",
    owner: "channel",
    removeAfter: "2026-08-15",
    replacement: "`openclaw/plugin-sdk/channel-ingress-runtime`",
  },
  {
    code: "plugin-sdk-zod-subpath",
    subpath: "zod",
    owner: "sdk",
    removeAfter: "2026-08-15",
    replacement: "the direct `zod` package import",
  },
] as const satisfies readonly DeprecatedPluginSdkSubpathSeed[];

const DEPRECATED_PLUGIN_SDK_SUBPATH_RECORDS = DEPRECATED_PLUGIN_SDK_SUBPATH_SEEDS.map(
  ({ code, subpath, owner, removeAfter, replacement }) => {
    return {
      code,
      status: "deprecated" as const,
      owner,
      introduced: "2026-07-06",
      deprecated: "2026-07-06",
      warningStarts: "2026-07-06",
      removeAfter,
      replacement,
      docsPath: "/plugins/sdk-migration",
      surfaces: [`openclaw/plugin-sdk/${subpath}`],
      diagnostics: [
        "repository deprecated API usage guard for core and bundled plugins; no external runtime import warning",
      ],
      tests: ["src/plugins/compat/registry.test.ts"],
    } satisfies PluginCompatRecord;
  },
) satisfies readonly PluginCompatRecord[];

const BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATHS = [
  "agent-media-payload",
  "media-understanding",
  "memory-host-core",
  "plugin-config-runtime",
  "tool-plugin",
] as const;

const DOCUMENTED_PUBLIC_PLUGIN_SDK_REPLACEMENTS: Record<
  string,
  { replacement: string; docsPath: string }
> = {
  "agent-media-payload": {
    replacement:
      "typed outbound payload planning via `openclaw/plugin-sdk/channel-outbound`; retain the facade for operator-supplied local-media root resolution until a focused public seam exists",
    docsPath: "/plugins/sdk-channel-plugins",
  },
  "media-understanding": {
    replacement:
      "`api.registerMediaUnderstandingProvider(...)` with provider-owned request helpers and types from `openclaw/plugin-sdk/plugin-entry`",
    docsPath: "/plugins/architecture",
  },
  "memory-host-core": {
    replacement:
      "host-prepared memory prompts via `openclaw/plugin-sdk/core` and memory capability registration through the injected plugin API; retain the facade for companion-plugin public-artifact discovery until a focused read seam exists",
    docsPath: "/plugins/architecture-internals#context-engine-plugins",
  },
  "plugin-config-runtime": {
    replacement:
      "`api.pluginConfig`, runtime tool context config, and focused `config-contracts`, `runtime-config-snapshot`, or `config-mutation` subpaths",
    docsPath: "/plugins/sdk-runtime",
  },
};

const BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS = BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATHS.map(
  (subpath) => {
    const documented = DOCUMENTED_PUBLIC_PLUGIN_SDK_REPLACEMENTS[subpath];
    return {
      code: `plugin-sdk-${subpath}-public-demotion` as const,
      status: "removal-pending" as const,
      owner: "sdk" as const,
      introduced: "2026-07-15",
      deprecated: "2026-07-15",
      warningStarts: "2026-07-15",
      removeAfter: "2026-07-30",
      replacement:
        subpath === "tool-plugin"
          ? "retain the public subpath until plugin authoring has a nonexecuting static metadata replacement for `defineToolPlugin`"
          : `${documented?.replacement ?? "define and document a public replacement"}; retain the public subpath until the 2026-07-30 window closes and official plugin consumers migrate`,
      docsPath:
        subpath === "tool-plugin"
          ? "/plugins/tool-plugins"
          : (documented?.docsPath ?? "/plugins/sdk-migration"),
      surfaces: [`openclaw/plugin-sdk/${subpath}`],
      diagnostics: [
        "registry-backed public SDK demotion window; no external runtime import warning",
      ],
      tests: ["src/plugins/compat/registry.test.ts"],
    } satisfies PluginCompatRecord;
  },
) satisfies readonly PluginCompatRecord[];

const PLUGIN_COMPAT_RECORDS = [
  ...DEPRECATED_PLUGIN_SDK_SUBPATH_RECORDS,
  ...BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS,
  {
    code: "removed-global-api-provider-publication",
    status: "removed",
    owner: "sdk",
    introduced: "2026-05-27",
    replacement:
      "provider plugins via `api.registerProvider(...)`; host/runtime code registers against its lifecycle-owned `ApiRegistry`",
    docsPath: "/plugins/sdk-migration#process-global-api-provider-publication",
    surfaces: [
      "openclaw/plugin-sdk/llm registerApiProvider",
      "openclaw/plugin-sdk/llm unregisterApiProviders",
    ],
    diagnostics: ["plugin SDK compatibility registry and migration guide"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      "The process-global API-provider publication facade was removed; provider plugins now publish through their lifecycle-owned registration, and host runtimes register directly on their prepared ApiRegistry.",
  },
  {
    code: "legacy-deactivate-hook-alias",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-05-16",
    deprecated: "2026-05-16",
    warningStarts: "2026-05-16",
    removeAfter: "2026-08-16",
    replacement: "`gateway_stop` hook",
    docsPath: "/plugins/hooks#upcoming-deprecations",
    surfaces: ['api.on("deactivate", ...)', "plugin typed hook registration"],
    diagnostics: ["plugin runtime compatibility warning"],
    tests: ["src/plugins/loader.test.ts"],
    releaseNote:
      '`api.on("deactivate", ...)` remains wired as a deprecated compatibility alias while plugins migrate to `gateway_stop`.',
  },
  {
    code: "legacy-subagent-spawning-hook",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-05-30",
    deprecated: "2026-05-30",
    warningStarts: "2026-05-30",
    removeAfter: "2026-08-30",
    replacement:
      "`subagent_spawned` for post-launch observation; core session-binding adapters for thread routing",
    docsPath: "/plugins/hooks#upcoming-deprecations",
    surfaces: [
      'api.on("subagent_spawning", ...)',
      "PluginHookSubagentSpawningEvent",
      "PluginHookSubagentSpawningResult",
      "SubagentLifecycleHookRunner.runSubagentSpawning",
    ],
    diagnostics: ["plugin runtime compatibility warning"],
    tests: ["src/plugins/loader.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      '`api.on("subagent_spawning", ...)` remains wired only for older plugins; core now owns thread-bound subagent routing.',
  },
  {
    code: "hook-only-plugin-shape",
    status: "active",
    owner: "sdk",
    introduced: "2026-04-24",
    replacement: "explicit capability registration",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["plugin shape inspection", "plugins inspect", "status diagnostics"],
    diagnostics: ["plugin compatibility notice"],
    tests: ["src/plugins/status.test.ts", "src/plugins/contracts/shape.contract.test.ts"],
  },
  {
    code: "deprecated-memory-embedding-provider-api",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-05-21",
    deprecated: "2026-05-21",
    warningStarts: "2026-05-21",
    removeAfter: "2026-08-21",
    replacement: "`api.registerEmbeddingProvider(...)` and `contracts.embeddingProviders`",
    docsPath: "/plugins/sdk-migration#memory-embedding-provider-api",
    surfaces: [
      "api.registerMemoryEmbeddingProvider(...)",
      "contracts.memoryEmbeddingProviders",
      "openclaw/plugin-sdk/memory-core-host-engine-embeddings registerMemoryEmbeddingProvider",
      "plugins inspect compatibility notices",
    ],
    diagnostics: ["plugin compatibility notice", "plugin SDK package guardrail"],
    tests: [
      "src/plugins/status.test.ts",
      "src/plugins/compat/registry.test.ts",
      "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
    ],
    releaseNote:
      "Memory-specific embedding provider registration remains wired as a deprecated compatibility path while providers migrate to the generic embedding provider contract.",
  },
  {
    code: "deprecated-session-store-beta5-api",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-05-21",
    deprecated: "2026-07-12",
    warningStarts: "2026-07-12",
    removeAfter: "2026-10-12",
    replacement:
      "`getSessionEntry(...)`, `listSessionEntries(...)`, and row-level session mutations",
    docsPath: "/plugins/sdk-migration#removed-session-and-transcript-file-apis",
    surfaces: [
      "openclaw/plugin-sdk/session-store-runtime loadSessionStore",
      "openclaw/plugin-sdk/session-store-runtime updateSessionStore",
      "openclaw/plugin-sdk/session-store-runtime resolveSessionFilePath",
      "openclaw/plugin-sdk/session-store-runtime resolveSessionStoreEntry",
    ],
    diagnostics: ["plugin SDK deprecation"],
    tests: ["src/plugin-sdk/session-store-runtime.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      "The beta.5 session-store import set remains available for official plugins released with v2026.7.1-beta.5 while they migrate to row-level session access.",
  },
  {
    code: "removed-session-transcript-file-api",
    status: "removed",
    owner: "sdk",
    introduced: "2026-07-01",
    replacement:
      "session identity (`sessionKey`/`sessionId`), `SessionTranscriptUpdate.target`, and Gateway/runtime session helpers",
    docsPath: "/plugins/sdk-migration#removed-session-and-transcript-file-apis",
    surfaces: [
      "saveSessionStore",
      "resolveSessionTranscriptPathInDir",
      "resolveAndPersistSessionFile",
      "readLatestAssistantTextFromSessionTranscript",
      "SessionTranscriptUpdate.sessionFile",
      "sessionFiles",
      "transcriptPath",
      "sessionFile",
      "plugins inspect compatibility notices",
    ],
    diagnostics: ["plugin compatibility notice"],
    tests: ["src/plugins/status.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      "Session/transcript file APIs were removed with the SQLite session storage flip; plugins now use session identity and Gateway/runtime session helpers.",
  },
  {
    code: "hook.before_tool_call.terminal-block-approval",
    status: "active",
    owner: "agent-runtime",
    introduced: "2026-04-29",
    docsPath: "/plugins/hooks",
    surfaces: ["before_tool_call block result", "before_tool_call approval result"],
    diagnostics: ["hook runner contract probe"],
    tests: [
      "src/plugins/hooks.security.test.ts",
      "src/agents/agent-tools.before-tool-call.e2e.test.ts",
    ],
  },
  {
    code: "hook.llm-observer.privacy-payload",
    status: "active",
    owner: "agent-runtime",
    introduced: "2026-04-29",
    docsPath: "/plugins/hooks",
    surfaces: ["llm_input", "llm_output", "agent_end", "allowConversationAccess"],
    diagnostics: ["conversation access hook contract probe"],
    tests: ["src/agents/cli-runner.reliability.test.ts", "src/config/schema.help.quality.test.ts"],
  },
  {
    code: "api.capture.runtime-registrars",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-29",
    docsPath: "/plugins/architecture-internals",
    surfaces: [
      "createCapturedPluginRegistration",
      "capturePluginRegistration",
      "OpenClawPluginApi",
    ],
    diagnostics: ["runtime registration capture contract probe"],
    tests: ["src/plugins/captured-registration.test.ts"],
  },
  {
    code: "channel.runtime.envelope-config-metadata",
    status: "active",
    owner: "channel",
    introduced: "2026-04-29",
    docsPath: "/plugins/sdk-channel-plugins",
    surfaces: ["api.registerChannel", "channel setup metadata", "channel message envelope"],
    diagnostics: ["channel runtime contract probe"],
    tests: [
      "src/plugin-sdk/channel-entry-contract.test.ts",
      "src/plugins/captured-registration.test.ts",
    ],
  },
  {
    code: "whatsapp-web-inbound-flat-message-aliases",
    status: "deprecated",
    owner: "channel",
    introduced: "2026-05-30",
    deprecated: "2026-05-30",
    warningStarts: "2026-05-30",
    removeAfter: "2026-08-30",
    replacement:
      "WhatsApp `WebInboundCallbackMessage` nested contexts: `event`, `payload`, `quote`, `group`, and `platform`",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "@openclaw/whatsapp WebInboundMessage flat fields",
      "WhatsApp monitorWebInbox onMessage callback",
      "WhatsApp monitorWebChannel listenerFactory injected messages",
    ],
    diagnostics: ["TypeScript deprecated WebInboundMessage flat field annotations"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      "WhatsApp WebInboundMessage flat fields remain wired as deprecated aliases while callbacks migrate to nested inbound contexts.",
  },
  {
    code: "whatsapp-web-inbound-admission-top-level-fields",
    status: "deprecated",
    owner: "channel",
    introduced: "2026-06-14",
    deprecated: "2026-06-14",
    warningStarts: "2026-06-14",
    removeAfter: "2026-08-30",
    replacement:
      "WhatsApp `WebInboundMessage.admission` fields: `conversation.id`, `accountId`, `ingress.decision`, and `conversation.kind`",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "@openclaw/whatsapp WebInboundMessage top-level admission fields",
      "WhatsApp monitorWebInbox onMessage callback",
      "WhatsApp monitorWebChannel listenerFactory injected messages",
    ],
    diagnostics: ["TypeScript deprecated WebInboundMessage admission field annotations"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      "WhatsApp WebInboundMessage top-level admission fields remain available while callbacks migrate to the admission envelope.",
  },
  {
    code: "bundled-channel-sdk-compat-facades",
    status: "active",
    owner: "sdk",
    introduced: "2026-04-28",
    replacement:
      "generic channel SDK subpaths or plugin-local `api.ts` / `runtime-api.ts` barrels for new plugins",
    docsPath: "/plugins/sdk-overview",
    surfaces: [
      "openclaw/plugin-sdk/discord component message helpers",
      "openclaw/plugin-sdk/telegram-account resolveTelegramAccount",
    ],
    diagnostics: ["plugin SDK compatibility registry"],
    tests: [
      "src/plugin-sdk/discord.test.ts",
      "src/plugin-sdk/telegram-account.test.ts",
      "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
    ],
  },
  {
    code: "channel-explicit-target-parser",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-04-28",
    deprecated: "2026-05-23",
    warningStarts: "2026-05-23",
    removeAfter: "2026-08-23",
    replacement:
      "`messaging.targetResolver` for target normalization and `messaging.resolveOutboundSessionRoute` for session/thread identity",
    docsPath: "/plugins/sdk-migration",
    surfaces: [
      "ChannelMessagingAdapter.parseExplicitTarget",
      "openclaw/plugin-sdk/channel-route ChannelRouteExplicitTarget",
      "openclaw/plugin-sdk/channel-route ChannelRouteExplicitTargetParser",
      "openclaw/plugin-sdk/channel-route resolveChannelRouteTargetWithParser",
    ],
    diagnostics: ["plugin SDK compatibility warning"],
    tests: [
      "src/channels/plugins/contracts/test-helpers/surface-contract-suite.ts",
      "src/plugins/compat/registry.test.ts",
    ],
  },
  {
    code: "channel-messaging-targets-subpath",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-04-28",
    deprecated: "2026-05-23",
    warningStarts: "2026-05-23",
    removeAfter: "2026-08-23",
    replacement: "`openclaw/plugin-sdk/channel-targets`",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["openclaw/plugin-sdk/messaging-targets"],
    diagnostics: ["plugin SDK compatibility warning"],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
    ],
  },
  {
    code: "bundled-plugin-allowlist",
    status: "active",
    owner: "config",
    introduced: "2026-04-24",
    replacement: "manifest-owned plugin enablement and scoped load plans",
    docsPath: "/plugins/architecture",
    surfaces: ["plugins.allow", "bundled provider startup", "plugins status"],
    diagnostics: ["plugin status report"],
    tests: ["src/plugins/status.test.ts", "src/plugins/config-state.test.ts"],
  },
  {
    code: "bundled-plugin-enablement",
    status: "active",
    owner: "config",
    introduced: "2026-04-24",
    replacement: "manifest-owned plugin defaults and scoped load plans",
    docsPath: "/plugins/architecture",
    surfaces: ["plugins.entries", "bundled provider startup", "plugins status"],
    diagnostics: ["plugin status report"],
    tests: ["src/plugins/status.test.ts", "src/plugins/config-state.test.ts"],
  },
  {
    code: "bundled-plugin-vitest-defaults",
    status: "active",
    owner: "config",
    introduced: "2026-04-24",
    replacement: "explicit test plugin config fixtures",
    docsPath: "/plugins/architecture",
    surfaces: ["Vitest plugin defaults", "bundled provider tests"],
    diagnostics: ["test-only compatibility path"],
    tests: ["src/plugins/config-state.test.ts"],
  },
  {
    code: "activation-agent-harness-hint",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-24",
    replacement:
      "top-level `cliBackends[]` for CLI aliases and future `agentRuntime` ownership metadata",
    docsPath: "/plugins/manifest",
    surfaces: ["activation.onAgentHarnesses", "activation planner"],
    diagnostics: ["activation plan compat reason"],
    tests: ["src/plugins/activation-planner.test.ts"],
  },
  {
    code: "activation-provider-hint",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-24",
    replacement: "`providers[]` manifest ownership",
    docsPath: "/plugins/manifest",
    surfaces: ["activation.onProviders", "activation planner"],
    diagnostics: ["activation plan compat reason"],
    tests: ["src/plugins/activation-planner.test.ts"],
  },
  {
    code: "activation-channel-hint",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-24",
    replacement: "`channels[]` manifest ownership",
    docsPath: "/plugins/manifest",
    surfaces: ["activation.onChannels", "activation planner"],
    diagnostics: ["activation plan compat reason"],
    tests: ["src/plugins/activation-planner.test.ts"],
  },
  {
    code: "activation-command-hint",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-24",
    replacement: "`commandAliases` or command contribution metadata",
    docsPath: "/plugins/manifest",
    surfaces: ["activation.onCommands", "activation planner"],
    diagnostics: ["activation plan compat reason"],
    tests: ["src/plugins/activation-planner.test.ts"],
  },
  {
    code: "activation-route-hint",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-24",
    replacement: "HTTP route contribution metadata",
    docsPath: "/plugins/manifest",
    surfaces: ["activation.onRoutes", "activation planner"],
    diagnostics: ["activation plan compat reason"],
    tests: ["src/plugins/activation-planner.test.ts"],
  },
  {
    code: "activation-config-path-hint",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-27",
    replacement: "manifest contribution ownership for root config surfaces",
    docsPath: "/plugins/manifest",
    surfaces: ["activation.onConfigPaths", "startup plugin selection"],
    diagnostics: ["activation plan compat reason"],
    tests: ["src/plugins/channel-plugin-ids.test.ts"],
  },
  {
    code: "activation-capability-hint",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-24",
    replacement: "manifest contribution ownership",
    docsPath: "/plugins/manifest",
    surfaces: ["activation.onCapabilities", "activation planner"],
    diagnostics: ["activation plan compat reason"],
    tests: ["src/plugins/activation-planner.test.ts"],
  },
  {
    code: "agent-harness-sdk-alias",
    status: "removal-pending",
    owner: "agent-runtime",
    introduced: "2026-04-24",
    deprecated: "2026-04-25",
    warningStarts: "2026-04-25",
    removeAfter: "2026-07-25",
    replacement:
      "`openclaw/plugin-sdk/agent-runtime`; retain the public aliases until the shipped SDK contract has a replacement window backed by external-usage proof",
    docsPath: "/plugins/sdk-agent-harness",
    surfaces: ["openclaw/plugin-sdk/agent-harness", "openclaw/plugin-sdk/agent-harness-runtime"],
    diagnostics: ["plugin SDK compatibility warning"],
    tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"],
  },
  {
    code: "embedded-pi-agent-sdk-aliases",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-05-21",
    deprecated: "2026-05-21",
    warningStarts: "2026-05-21",
    removeAfter: "2026-08-21",
    replacement: "`runEmbeddedAgent` and `EmbeddedAgent*` SDK/runtime names",
    docsPath: "/plugins/sdk-runtime",
    surfaces: [
      "api.runtime.agent.runEmbeddedPiAgent",
      "openclaw/extension-api runEmbeddedPiAgent",
      "openclaw/plugin-sdk/agent-harness-runtime EmbeddedPi* aliases",
    ],
    diagnostics: ["plugin SDK compatibility registry"],
    tests: [
      "src/plugins/runtime/index.test.ts",
      "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
    ],
    releaseNote:
      "Legacy `runEmbeddedPiAgent` and `EmbeddedPi*` plugin aliases remain as deprecated SDK compatibility only.",
  },
  {
    code: "plugin-sdk-shipped-channel-setup-exports",
    status: "deprecated",
    owner: "channel",
    introduced: "2026-07-23",
    deprecated: "2026-07-23",
    warningStarts: "2026-07-23",
    removeAfter: "2026-08-30",
    replacement:
      "plugin-owned config schemas plus generic `openclaw/plugin-sdk/channel-config-schema` and `openclaw/plugin-sdk/setup-runtime` primitives",
    docsPath: "/plugins/sdk-migration#published-channel-setup-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/bundled-channel-config-schema SlackConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema DiscordConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema SignalConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema MSTeamsConfigSchema",
      "openclaw/plugin-sdk/setup-runtime createLegacyCompatChannelDmPolicy",
      "openclaw/plugin-sdk/setup-runtime promptLegacyChannelAllowFromForAccount",
    ],
    diagnostics: [
      "repository deprecated API usage guard for core and bundled plugins; no external runtime import warning",
    ],
    tests: ["src/plugin-sdk/shipped-channel-compat.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      "Published OpenClaw channel packages through 2026.7.1 remain loadable while they migrate to plugin-owned config and setup helpers.",
  },
  {
    code: "generated-bundled-channel-config-fallback",
    status: "active",
    owner: "channel",
    introduced: "2026-04-24",
    replacement: "manifest registry `channelConfigs` metadata",
    docsPath: "/plugins/manifest",
    surfaces: ["generated bundled channel config metadata", "channel config validation"],
    diagnostics: ["channel config metadata fallback"],
    tests: ["src/plugins/contracts/config-footprint-guardrails.test.ts"],
  },
  {
    code: "setup-runtime-fallback",
    status: "active",
    owner: "setup",
    introduced: "2026-04-24",
    replacement: "`setup.requiresRuntime: false` with complete setup descriptors",
    docsPath: "/plugins/manifest#setup-reference",
    surfaces: ["setup-api runtime fallback", "setup.requiresRuntime omitted"],
    diagnostics: ["setup registry runtime diagnostic"],
    tests: ["src/plugins/setup-registry.test.ts", "src/plugins/setup-registry.runtime.test.ts"],
  },
] as const satisfies readonly PluginCompatRecord[];

export type PluginCompatCode = (typeof PLUGIN_COMPAT_RECORDS)[number]["code"];
type KnownPluginCompatRecord = PluginCompatRecord<PluginCompatCode>;

const pluginCompatRecordByCode = new Map<PluginCompatCode, KnownPluginCompatRecord>(
  PLUGIN_COMPAT_RECORDS.map((record) => [record.code, record]),
);

export function listPluginCompatRecords(): readonly KnownPluginCompatRecord[] {
  return PLUGIN_COMPAT_RECORDS;
}

export function getPluginCompatRecord(code: PluginCompatCode): KnownPluginCompatRecord {
  const record = pluginCompatRecordByCode.get(code);
  if (!record) {
    throw new Error(`Unknown plugin compatibility code: ${code}`);
  }
  return record;
}
