// Inventory of doctor compatibility migrations that outlive deprecated runtime/config paths.
type DoctorDeprecationCompatStatus = "active" | "deprecated" | "removal-pending" | "removed";

type DoctorDeprecationCompatOwner =
  | "agent-runtime"
  | "audio"
  | "browser"
  | "channel"
  | "config"
  | "gateway"
  | "plugin"
  | "provider"
  | "tools"
  | "tts";

export type DoctorDeprecationCompatRecord = {
  /** Stable inventory code for a doctor compatibility surface. */
  code: string;
  /** Current lifecycle state for the compatibility surface. */
  status: DoctorDeprecationCompatStatus;
  /** Area that owns the deprecated input or migration. */
  owner: DoctorDeprecationCompatOwner;
  /** Date or release window when the compatibility surface first shipped. */
  introduced: string;
  deprecated?: string;
  warningStarts?: string;
  removeAfter?: string;
  previousRemoveAfter?: string;
  renewedAt?: string;
  source: string;
  migration: string;
  replacement: string;
  docsPath: string;
  tests: readonly string[];
  notes?: string;
};

const DEFAULT_TESTS = ["src/commands/doctor/shared/legacy-config-migrate.test.ts"] as const;

const DOCTOR_COMPAT_RENEWED_AT = "2026-08-29";
const DOCTOR_COMPAT_RENEWED_REMOVE_AFTER = "2026-11-29";

type CompatRecordDeadline =
  | { removeAfter: string; previousRemoveAfter?: never }
  | { previousRemoveAfter: string; removeAfter?: never };

type CompatRecordInput = CompatRecordDeadline & {
  owner: DoctorDeprecationCompatOwner;
  introduced: string;
  deprecated?: string;
  warningStarts?: string;
  source: string;
  migration: string;
  replacement: string;
  docsPath: string;
  tests?: readonly string[];
  notes?: string;
};

function compatRecord(
  code: string,
  status: DoctorDeprecationCompatStatus,
  record: CompatRecordInput,
): DoctorDeprecationCompatRecord {
  const renewedDeadline =
    record.previousRemoveAfter === undefined
      ? {}
      : {
          renewedAt: DOCTOR_COMPAT_RENEWED_AT,
          removeAfter: DOCTOR_COMPAT_RENEWED_REMOVE_AFTER,
        };
  return {
    code,
    status,
    deprecated: record.introduced,
    warningStarts: record.introduced,
    tests: DEFAULT_TESTS,
    ...record,
    ...renewedDeadline,
  };
}

function deprecatedCompatRecord(
  code: string,
  record: CompatRecordInput,
): DoctorDeprecationCompatRecord {
  return compatRecord(code, "deprecated", record);
}

function removalPendingCompatRecord(
  code: string,
  record: CompatRecordInput,
): DoctorDeprecationCompatRecord {
  return compatRecord(code, "removal-pending", record);
}

function removedCompatRecord(
  code: string,
  record: CompatRecordInput,
): DoctorDeprecationCompatRecord {
  return compatRecord(code, "removed", record);
}

// Doctor migrations and repair shims can outlive the runtime/config compatibility
// path they repair. Release removals must check this inventory before deleting
// doctor fixes, and replacement notes should be revalidated against the current
// architecture because ownership and config footprint can shift during rollout.
const DOCTOR_DEPRECATION_COMPAT_RECORDS = [
  deprecatedCompatRecord("doctor-context-budget-one-knob", {
    previousRemoveAfter: "2026-11-16",
    owner: "config",
    introduced: "2026-08-16",
    source:
      "models.providers.* context defaults and agents.defaults/entries/list contextTokens caps",
    migration: "src/config/legacy.context-budget.ts",
    replacement:
      "models.providers.<provider>.models[].contextTokens active-input caps and per-model contextWindow metadata",
    docsPath: "/concepts/model-providers",
    tests: [
      "src/config/legacy.context-budget.test.ts",
      "src/config/io.compat.test.ts",
      "src/commands/doctor-config-flow.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-cli-backends-plugin-registration", {
    previousRemoveAfter: "2026-09-22",
    owner: "agent-runtime",
    introduced: "2026-07-21",
    source: "agents.defaults.cliBackends adapter DSL",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.cli-backends.ts",
    replacement: "registerCliBackend plugin registrations and model-scoped agentRuntime.id",
    docsPath: "/plugins/cli-backend-plugins",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrations.runtime.cli-backends.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-model-compat-catalog-ownership", {
    previousRemoveAfter: "2026-09-22",
    owner: "provider",
    introduced: "2026-07-21",
    source: "model compat capability ownership moved from known-model config to provider catalogs",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.models.ts",
    replacement: "provider catalog compat metadata, with config compat reserved for custom routes",
    docsPath: "/gateway/config-tools",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrations.runtime.models.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-tier-eval-tranche", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-20",
    source: "approved tier-eval tranche 6a and small hookify retirements",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement:
      "canonical config owners, shared SQLite state, built-in defaults, and plugin hooks",
    docsPath: "/gateway/doctor",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-final-layout-polish", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-19",
    source: "final layout renames, removed knobs, and agents.list",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "canonical final layout and built-in defaults",
    docsPath: "/gateway/doctor",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrate.e2e.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-phase4-product-config-retirements", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-19",
    source: "systemAgent; crestodian; marketplaces; cli.banner.taglineMode; commitments",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "built-in rescue, marketplace, banner, and retired commitments behavior",
    docsPath: "/gateway/doctor",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-media-models-consolidation", {
    previousRemoveAfter: "2026-09-18",
    owner: "tools",
    introduced: "2026-07-19",
    source: "tools.media.image/audio/video models",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "capability-tagged tools.media.models plus per-capability policy and defaults",
    docsPath: "/nodes/media-understanding",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-runtime-tuning-knobs-purge", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-19",
    source: "retired runtime and bundled-channel numeric tuning knobs",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "built-in runtime and channel defaults",
    docsPath: "/gateway/doctor",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-phase2-channel-dm-aliases", {
    previousRemoveAfter: "2026-09-18",
    owner: "channel",
    introduced: "2026-07-18",
    source: "Discord, Slack, and Google Chat dm.policy and dm.allowFrom",
    migration: "src/config/channel-alias-migration.ts",
    replacement: "dmPolicy and allowFrom at the same channel or account level",
    docsPath: "/cli/doctor",
    tests: ["src/config/channel-alias-migration.test.ts", "src/config/dead-config-keys.test.ts"],
  }),
  deprecatedCompatRecord("doctor-phase1-retired-runtime-config", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source:
      "tui; commands.modelsWrite; messages.messagePrefix; tools media/message aliases; realtime voice aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement:
      "canonical channel, media providerOptions, crossContext, and speakerVoice settings",
    docsPath: "/cli/doctor",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-root-default-model", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "defaultModel",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.models.ts",
    replacement: "agents.defaults.model",
    docsPath: "/gateway/doctor",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-session-prune-reset-aliases", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "session.maintenance.pruneDays; session.resetByType.dm",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.session.ts",
    replacement: "session.maintenance.pruneAfter; session.resetByType.direct",
    docsPath: "/gateway/configuration-reference",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-mcp-timeout-aliases", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "mcp.servers.*.connectTimeout; connect_timeout; timeout",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.mcp.ts",
    replacement: "connectionTimeoutMs; requestTimeoutMs",
    docsPath: "/cli/mcp",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-cron-webhook-fallback", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "cron.webhook",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.cron.ts",
    replacement: "per-job delivery.to or delivery.completionDestination",
    docsPath: "/automation/cron-jobs",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-canvas-host-root", {
    previousRemoveAfter: "2026-09-18",
    owner: "plugin",
    introduced: "2026-07-18",
    source: "canvasHost",
    migration: "extensions/canvas/setup-api.ts",
    replacement: "plugins.entries.canvas.config.host",
    docsPath: "/plugins",
    tests: ["src/plugins/setup-registry.migrations.test.ts"],
  }),
  deprecatedCompatRecord("doctor-phase1-channel-noops-aliases", {
    previousRemoveAfter: "2026-09-18",
    owner: "channel",
    introduced: "2026-07-18",
    source:
      "Telegram topics; Slack DM reply mode; WhatsApp exposeErrorText; Google Chat reactions; thread binding spawn aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "canonical channel settings or removal",
    docsPath: "/channels/channel-routing",
    tests: ["src/config/dead-config-keys.test.ts"],
  }),
  removalPendingCompatRecord("doctor-agent-llm-timeout", {
    owner: "agent-runtime",
    introduced: "2026-04-27",
    previousRemoveAfter: "2026-07-26",
    source: "agents.defaults.llm.idleTimeoutSeconds",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "models.providers.<id>.timeoutSeconds",
    docsPath: "/gateway/config-agents",
    notes:
      "The old agent-level idle timeout knob was collapsed into provider request timeout handling, bounded by the agent/run timeout ceiling.",
  }),
  removalPendingCompatRecord("doctor-agent-runtime-embedded-harness", {
    owner: "agent-runtime",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "agents.defaults.embeddedHarness; agents.list[].embeddedHarness",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "models.providers.<provider>.agentRuntime or model-scoped agentRuntime",
    docsPath: "/plugins/sdk-agent-harness",
    notes:
      "Whole-agent runtime pins are retired; doctor preserves intent only when it can move the value to provider/model runtime policy.",
  }),
  removalPendingCompatRecord("doctor-agent-embedded-pi-config", {
    owner: "agent-runtime",
    introduced: "2026-05-21",
    previousRemoveAfter: "2026-07-26",
    source: "agents.defaults.embeddedPi; agents.list[].embeddedPi",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.embeddedAgent; agents.list[].embeddedAgent",
    docsPath: "/gateway/config-agents",
    notes:
      "Runtime code no longer reads the legacy key; doctor keeps this migration only to preserve shipped configs during upgrade.",
  }),
  removalPendingCompatRecord("doctor-agent-sandbox-persession", {
    owner: "agent-runtime",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "agents.defaults.sandbox.perSession; agents.list[].sandbox.perSession",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.*.sandbox.scope",
    docsPath: "/cli/doctor",
  }),
  deprecatedCompatRecord("doctor-memory-search-owner-consolidation", {
    previousRemoveAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-19",
    source: "memorySearch; agents.defaults.memorySearch; agents.list[].memorySearch",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "memory.search; agents.list[].memory.search",
    docsPath: "/reference/memory-config",
  }),
  deprecatedCompatRecord("doctor-session-typing-mode-owner", {
    previousRemoveAfter: "2026-09-18",
    owner: "agent-runtime",
    introduced: "2026-07-19",
    source: "session.typingMode",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.typingMode or agents.list[].typingMode",
    docsPath: "/concepts/typing-indicators",
  }),
  removalPendingCompatRecord("doctor-top-level-heartbeat", {
    owner: "config",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "heartbeat",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.heartbeat and channels.defaults.heartbeat",
    docsPath: "/automation",
  }),
  removalPendingCompatRecord("doctor-mcp-server-type-alias", {
    owner: "config",
    introduced: "2026-04-27",
    previousRemoveAfter: "2026-07-26",
    source: "mcp.servers.*.type",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.mcp.ts",
    replacement: "mcp.servers.*.transport",
    docsPath: "/cli/mcp",
    notes:
      "OpenClaw stores transport names; CLI backends receive their own type fields through runtime adapters.",
  }),
  removalPendingCompatRecord("doctor-gateway-bind-host-aliases", {
    owner: "gateway",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "gateway.bind host aliases such as 0.0.0.0 and localhost",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.gateway.ts",
    replacement: "gateway.bind.mode values such as lan, loopback, custom, tailnet, and auto",
    docsPath: "/gateway/configuration",
  }),
  removalPendingCompatRecord("doctor-audio-transcription-command", {
    owner: "audio",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "audio.transcription",
    migration: "src/commands/doctor/shared/legacy-config-migrations.audio.ts",
    replacement: "capability-tagged tools.media.models",
    docsPath: "/tools/media-overview",
  }),
  removalPendingCompatRecord("doctor-channel-thread-binding-ttl", {
    owner: "channel",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "threadBindings.ttlHours",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "threadBindings.idleHours",
    docsPath: "/channels/channel-routing",
  }),
  removalPendingCompatRecord("doctor-message-queue-steering-modes", {
    owner: "config",
    introduced: "2026-05-04",
    previousRemoveAfter: "2026-07-26",
    source: "messages.queue.mode and messages.queue.byChannel retired queue modes",
    migration: "src/commands/doctor/shared/legacy-config-migrations.queue.ts",
    replacement: "steer, followup, collect, or interrupt queue modes",
    docsPath: "/concepts/queue",
  }),
  removalPendingCompatRecord("doctor-channel-dm-aliases", {
    owner: "channel",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "channels.<id>.dm.policy and channels.<id>.dm.allowFrom",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.dmPolicy and channels.<id>.allowFrom",
    docsPath: "/channels/channel-routing",
    tests: ["src/commands/doctor/shared/channel-legacy-config-migrate.test.ts"],
  }),
  removalPendingCompatRecord("doctor-channel-streaming-aliases", {
    owner: "channel",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "streamMode, scalar streaming, chunkMode, blockStreaming, draftChunk, nativeStreaming",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.streaming.*",
    docsPath: "/channels/channel-routing",
    tests: ["src/commands/doctor/shared/channel-legacy-config-migrate.test.ts"],
    notes:
      "Runtime reads are nested-only; doctor keeps this migration to move shipped configs during upgrade.",
  }),
  removedCompatRecord("doctor-webchat-channel-config", {
    owner: "channel",
    introduced: "2026-05-18",
    deprecated: "2026-05-31",
    warningStarts: "2026-05-31",
    previousRemoveAfter: "2026-08-31",
    source: "channels.webchat",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "chat.history maxChars per-request override when a custom client needs it",
    docsPath: "/web/webchat",
    notes:
      "WebChat is an internal control surface, not a configurable outbound channel. Runtime ignores the retired channel key; doctor removes stale config.",
  }),
  deprecatedCompatRecord("doctor-tts-top-level-owner", {
    previousRemoveAfter: "2026-09-18",
    owner: "tts",
    introduced: "2026-07-19",
    source: "messages.tts",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "top-level tts",
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.provider-shapes.test.ts"],
  }),
  removalPendingCompatRecord("doctor-tts-provider-aliases", {
    owner: "tts",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "messages.tts.openai/elevenlabs/edge and plugins.entries.voice-call.config.tts aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "tts.providers.<provider> and microsoft instead of edge",
    docsPath: "/tools/tts",
  }),
  removalPendingCompatRecord("doctor-tts-enabled-auto-mode", {
    owner: "tts",
    introduced: "2026-04-29",
    previousRemoveAfter: "2026-07-26",
    source:
      "messages.tts.enabled, agents.list[].tts.enabled, supported channel TTS enabled fields, and voice-call plugin tts.enabled",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement:
      'supported top-level/agents/channels/plugins TTS auto mode, for example auto: "always" or auto: "off"',
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.provider-shapes.test.ts"],
  }),
  removalPendingCompatRecord("doctor-tts-speaker-selection-fields", {
    owner: "tts",
    introduced: "2026-05-28",
    previousRemoveAfter: "2026-07-26",
    source: "TTS provider speaker selection fields named voice, voiceName, and voiceId",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "speakerVoice and speakerVoiceId",
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.provider-shapes.test.ts"],
  }),
  removalPendingCompatRecord("doctor-plugin-install-config-ledger", {
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "plugins.installs in authored config",
    migration: "src/config/plugin-install-config-migration.ts",
    replacement: "shared SQLite config_machine_state plugins.installedIndex install ledger",
    docsPath: "/cli/plugins#registry",
    tests: [
      "src/config/io.write-config.test.ts",
      "src/commands/doctor/shared/plugin-registry-migration.test.ts",
    ],
  }),
  removalPendingCompatRecord("doctor-bundled-plugin-load-paths", {
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "plugins.load.paths entries that point at bundled plugin source/dist locations",
    migration: "src/commands/doctor/shared/bundled-plugin-load-paths.ts",
    replacement: "packaged bundled plugins and the persisted plugin registry",
    docsPath: "/cli/plugins#registry",
    tests: ["src/commands/doctor/shared/bundled-plugin-load-paths.test.ts"],
  }),
  removalPendingCompatRecord("doctor-bundled-provider-discovery-allowlist", {
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "plugins.allow configs created before bundled provider discovery was explicit",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.providers.ts",
    replacement: "plugins.bundledDiscovery allowlist mode plus explicit plugin/provider entries",
    docsPath: "/cli/plugins#registry",
    notes:
      "Doctor preserves the shipped upgrade path only; runtime compatibility should stay behind explicit bundledDiscovery config.",
  }),
  deprecatedCompatRecord("doctor-codex-supervisor-plugin-config", {
    owner: "plugin",
    introduced: "2026-05-29",
    deprecated: "2026-07-09",
    warningStarts: "2026-07-09",
    previousRemoveAfter: "2026-10-09",
    source: "plugins.entries.codex-supervisor and codex-supervisor plugin policy references",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.providers.ts",
    replacement: "plugins.entries.codex.config.supervision",
    docsPath: "/plugins/codex-supervision",
    notes:
      "The core bootstrap migration must remain available when the external Codex plugin is not installed yet.",
  }),
  removalPendingCompatRecord("doctor-web-search-plugin-config", {
    owner: "provider",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "tools.web.search.apiKey and tools.web.search.<provider>",
    migration: "src/commands/doctor/shared/legacy-web-tools-migrate.ts",
    replacement: "plugins.entries.<plugin>.config.webSearch",
    docsPath: "/tools/web",
    tests: ["src/commands/doctor/shared/legacy-web-tools-migrate.test.ts"],
    notes:
      "Provider/plugin ownership can move as bundled providers externalize; verify the current manifest owner before deleting migration support.",
  }),
  removalPendingCompatRecord("doctor-web-fetch-plugin-config", {
    owner: "provider",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "tools.web.fetch.firecrawl",
    migration: "src/commands/doctor/shared/legacy-web-tools-migrate.ts",
    replacement: "plugins.entries.firecrawl.config.webFetch",
    docsPath: "/tools/web-fetch",
    tests: ["src/commands/doctor/shared/legacy-web-tools-migrate.test.ts"],
  }),
  removalPendingCompatRecord("doctor-x-search-plugin-config", {
    owner: "provider",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "tools.web.x_search.apiKey",
    migration: "src/commands/doctor/shared/legacy-web-tools-migrate.ts",
    replacement: "plugins.entries.xai.config.webSearch.apiKey",
    docsPath: "/tools/grok-search",
    tests: [
      "src/commands/doctor/shared/legacy-web-tools-migrate.test.ts",
      "src/commands/doctor/shared/legacy-config-migrate.test.ts",
    ],
  }),
  removalPendingCompatRecord("doctor-talk-provider-shape", {
    owner: "tts",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "legacy talk provider scalar fields and provider/provider ids",
    migration: "src/commands/doctor/shared/legacy-talk-config-normalizer.ts",
    replacement: "talk.providers.<provider>",
    docsPath: "/tools/tts",
  }),
  removalPendingCompatRecord("doctor-legacy-tools-by-sender", {
    owner: "tools",
    introduced: "2026-04-26",
    previousRemoveAfter: "2026-07-26",
    source: "untyped toolsBySender keys",
    migration: "src/commands/doctor/shared/legacy-tools-by-sender.ts",
    replacement: "typed id:, e164:, username:, or name: sender keys",
    docsPath: "/tools/exec-approvals",
    tests: ["src/commands/doctor/shared/legacy-tools-by-sender.test.ts"],
  }),
] as const satisfies readonly DoctorDeprecationCompatRecord[];

/** List every doctor compatibility record, including removed or still-active entries. */
export function listDoctorDeprecationCompatRecords(): readonly DoctorDeprecationCompatRecord[] {
  return DOCTOR_DEPRECATION_COMPAT_RECORDS;
}
