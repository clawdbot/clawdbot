// Inventory of doctor compatibility migrations that outlive deprecated runtime/config paths.
export type DoctorDeprecationCompatStatus = "active" | "deprecated" | "removal-pending" | "removed";

export type DoctorDeprecationCompatOwner =
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

export type DoctorDeprecationCompatRecord<Code extends string = string> = {
  /** Stable inventory code for a doctor compatibility surface. */
  code: Code;
  /** Current lifecycle state for the compatibility surface. */
  status: DoctorDeprecationCompatStatus;
  /** Area that owns the deprecated input or migration. */
  owner: DoctorDeprecationCompatOwner;
  /** Date or release window when the compatibility surface first shipped. */
  introduced: string;
  deprecated?: string;
  warningStarts?: string;
  removeAfter?: string;
  source: string;
  migration: string;
  replacement: string;
  docsPath: string;
  tests: readonly string[];
  notes?: string;
};

const DEFAULT_TESTS = ["src/commands/doctor/shared/legacy-config-migrate.test.ts"] as const;

function deprecatedCompatRecord<Code extends string>(
  code: Code,
  record: Omit<
    DoctorDeprecationCompatRecord<Code>,
    "code" | "introduced" | "deprecated" | "warningStarts" | "removeAfter" | "status" | "tests"
  > &
    Required<Pick<DoctorDeprecationCompatRecord<Code>, "introduced" | "removeAfter">> &
    Partial<
      Pick<DoctorDeprecationCompatRecord<Code>, "deprecated" | "status" | "warningStarts" | "tests">
    >,
): DoctorDeprecationCompatRecord<Code> {
  return {
    code,
    status: "deprecated",
    deprecated: record.introduced,
    warningStarts: record.introduced,
    tests: DEFAULT_TESTS,
    ...record,
  };
}

// Doctor migrations and repair shims can outlive the runtime/config compatibility
// path they repair. Release removals must check this inventory before deleting
// doctor fixes, and replacement notes should be revalidated against the current
// architecture because ownership and config footprint can shift during rollout.
const DOCTOR_DEPRECATION_COMPAT_RECORDS = [
  deprecatedCompatRecord("doctor-cli-backends-plugin-registration", {
    removeAfter: "2026-09-22",
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
    removeAfter: "2026-09-22",
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
    removeAfter: "2026-09-18",
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
    removeAfter: "2026-09-18",
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
    removeAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-19",
    source: "systemAgent; crestodian; marketplaces; cli.banner.taglineMode; commitments",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.ts",
    replacement: "built-in rescue, marketplace, banner, and disabled commitments behavior",
    docsPath: "/gateway/doctor",
    tests: [
      "src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts",
      "src/config/dead-config-keys.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-media-models-consolidation", {
    removeAfter: "2026-09-18",
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
    removeAfter: "2026-09-18",
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
    removeAfter: "2026-09-18",
    owner: "channel",
    introduced: "2026-07-18",
    source: "Discord, Slack, and Google Chat dm.policy and dm.allowFrom",
    migration: "src/config/channel-alias-migration.ts",
    replacement: "dmPolicy and allowFrom at the same channel or account level",
    docsPath: "/cli/doctor",
    tests: ["src/config/channel-alias-migration.test.ts", "src/config/dead-config-keys.test.ts"],
  }),
  deprecatedCompatRecord("doctor-phase1-retired-runtime-config", {
    removeAfter: "2026-09-18",
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
    removeAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "defaultModel",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.models.ts",
    replacement: "agents.defaults.model",
    docsPath: "/gateway/doctor",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-session-prune-reset-aliases", {
    removeAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "session.maintenance.pruneDays; session.resetByType.dm",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.session.ts",
    replacement: "session.maintenance.pruneAfter; session.resetByType.direct",
    docsPath: "/gateway/configuration-reference",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-mcp-timeout-aliases", {
    removeAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "mcp.servers.*.connectTimeout; connect_timeout; timeout",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.mcp.ts",
    replacement: "connectionTimeoutMs; requestTimeoutMs",
    docsPath: "/cli/mcp",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-cron-webhook-fallback", {
    removeAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-18",
    source: "cron.webhook",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.cron.ts",
    replacement: "per-job delivery.to or delivery.completionDestination",
    docsPath: "/automation/cron-jobs",
    tests: ["src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts"],
  }),
  deprecatedCompatRecord("doctor-canvas-host-root", {
    removeAfter: "2026-09-18",
    owner: "plugin",
    introduced: "2026-07-18",
    source: "canvasHost",
    migration: "extensions/canvas/setup-api.ts",
    replacement: "plugins.entries.canvas.config.host",
    docsPath: "/plugins",
    tests: ["src/plugins/setup-registry.migrations.test.ts"],
  }),
  deprecatedCompatRecord("doctor-phase1-channel-noops-aliases", {
    removeAfter: "2026-09-18",
    owner: "channel",
    introduced: "2026-07-18",
    source:
      "Telegram topics; Slack DM reply mode; WhatsApp exposeErrorText; Google Chat reactions; thread binding spawn aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "canonical channel settings or removal",
    docsPath: "/channels/channel-routing",
    tests: ["src/config/dead-config-keys.test.ts"],
  }),
  deprecatedCompatRecord("doctor-agent-llm-timeout", {
    status: "removal-pending",
    owner: "agent-runtime",
    introduced: "2026-04-27",
    removeAfter: "2026-07-26",
    source: "agents.defaults.llm.idleTimeoutSeconds",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "models.providers.<id>.timeoutSeconds",
    docsPath: "/gateway/config-agents",
    notes:
      "The old agent-level idle timeout knob was collapsed into provider request timeout handling, bounded by the agent/run timeout ceiling.",
  }),
  deprecatedCompatRecord("doctor-agent-runtime-embedded-harness", {
    status: "removal-pending",
    owner: "agent-runtime",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "agents.defaults.embeddedHarness; agents.list[].embeddedHarness",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "models.providers.<provider>.agentRuntime or model-scoped agentRuntime",
    docsPath: "/plugins/sdk-agent-harness",
    notes:
      "Whole-agent runtime pins are retired; doctor preserves intent only when it can move the value to provider/model runtime policy.",
  }),
  deprecatedCompatRecord("doctor-agent-embedded-pi-config", {
    status: "removal-pending",
    owner: "agent-runtime",
    introduced: "2026-05-21",
    removeAfter: "2026-07-26",
    source: "agents.defaults.embeddedPi; agents.list[].embeddedPi",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.embeddedAgent; agents.list[].embeddedAgent",
    docsPath: "/gateway/config-agents",
    notes:
      "Runtime code no longer reads the legacy key; doctor keeps this migration only to preserve shipped configs during upgrade.",
  }),
  deprecatedCompatRecord("doctor-agent-sandbox-persession", {
    status: "removal-pending",
    owner: "agent-runtime",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "agents.defaults.sandbox.perSession; agents.list[].sandbox.perSession",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.*.sandbox.scope",
    docsPath: "/cli/doctor",
  }),
  deprecatedCompatRecord("doctor-memory-search-owner-consolidation", {
    removeAfter: "2026-09-18",
    owner: "config",
    introduced: "2026-07-19",
    source: "memorySearch; agents.defaults.memorySearch; agents.list[].memorySearch",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "memory.search; agents.list[].memory.search",
    docsPath: "/reference/memory-config",
  }),
  deprecatedCompatRecord("doctor-session-typing-mode-owner", {
    removeAfter: "2026-09-18",
    owner: "agent-runtime",
    introduced: "2026-07-19",
    source: "session.typingMode",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.typingMode or agents.list[].typingMode",
    docsPath: "/concepts/typing-indicators",
  }),
  deprecatedCompatRecord("doctor-top-level-heartbeat", {
    status: "removal-pending",
    owner: "config",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "heartbeat",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.heartbeat and channels.defaults.heartbeat",
    docsPath: "/automation",
  }),
  deprecatedCompatRecord("doctor-mcp-server-type-alias", {
    status: "removal-pending",
    owner: "config",
    introduced: "2026-04-27",
    removeAfter: "2026-07-26",
    source: "mcp.servers.*.type",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.mcp.ts",
    replacement: "mcp.servers.*.transport",
    docsPath: "/cli/mcp",
    notes:
      "OpenClaw stores transport names; CLI backends receive their own type fields through runtime adapters.",
  }),
  deprecatedCompatRecord("doctor-gateway-bind-host-aliases", {
    status: "removal-pending",
    owner: "gateway",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "gateway.bind host aliases such as 0.0.0.0 and localhost",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.gateway.ts",
    replacement: "gateway.bind.mode values such as lan, loopback, custom, tailnet, and auto",
    docsPath: "/gateway/configuration",
  }),
  deprecatedCompatRecord("doctor-audio-transcription-command", {
    status: "removal-pending",
    owner: "audio",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "audio.transcription",
    migration: "src/commands/doctor/shared/legacy-config-migrations.audio.ts",
    replacement: "capability-tagged tools.media.models",
    docsPath: "/tools/media-overview",
  }),
  deprecatedCompatRecord("doctor-channel-thread-binding-ttl", {
    status: "removal-pending",
    owner: "channel",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "threadBindings.ttlHours",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "threadBindings.idleHours",
    docsPath: "/channels/channel-routing",
  }),
  deprecatedCompatRecord("doctor-message-queue-steering-modes", {
    status: "removal-pending",
    owner: "config",
    introduced: "2026-05-04",
    removeAfter: "2026-07-26",
    source: "messages.queue.mode and messages.queue.byChannel retired queue modes",
    migration: "src/commands/doctor/shared/legacy-config-migrations.queue.ts",
    replacement: "steer, followup, collect, or interrupt queue modes",
    docsPath: "/concepts/queue",
  }),
  deprecatedCompatRecord("doctor-channel-dm-aliases", {
    status: "removal-pending",
    owner: "channel",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "channels.<id>.dm.policy and channels.<id>.dm.allowFrom",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.dmPolicy and channels.<id>.allowFrom",
    docsPath: "/channels/channel-routing",
    tests: ["src/commands/doctor/shared/channel-legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord("doctor-channel-streaming-aliases", {
    status: "removal-pending",
    owner: "channel",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "streamMode, scalar streaming, chunkMode, blockStreaming, draftChunk, nativeStreaming",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.streaming.*",
    docsPath: "/channels/channel-routing",
    tests: ["src/commands/doctor/shared/channel-legacy-config-migrate.test.ts"],
    notes:
      "Runtime reads are nested-only; doctor keeps this migration to move shipped configs during upgrade.",
  }),
  deprecatedCompatRecord("doctor-webchat-channel-config", {
    status: "removed",
    owner: "channel",
    introduced: "2026-05-18",
    deprecated: "2026-05-31",
    warningStarts: "2026-05-31",
    removeAfter: "2026-08-31",
    source: "channels.webchat",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "chat.history maxChars per-request override when a custom client needs it",
    docsPath: "/web/webchat",
    notes:
      "WebChat is an internal control surface, not a configurable outbound channel. Runtime ignores the retired channel key; doctor removes stale config.",
  }),
  deprecatedCompatRecord("doctor-tts-top-level-owner", {
    removeAfter: "2026-09-18",
    owner: "tts",
    introduced: "2026-07-19",
    source: "messages.tts",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "top-level tts",
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.provider-shapes.test.ts"],
  }),
  deprecatedCompatRecord("doctor-tts-provider-aliases", {
    status: "removal-pending",
    owner: "tts",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "messages.tts.openai/elevenlabs/edge and plugins.entries.voice-call.config.tts aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "tts.providers.<provider> and microsoft instead of edge",
    docsPath: "/tools/tts",
  }),
  deprecatedCompatRecord("doctor-tts-enabled-auto-mode", {
    status: "removal-pending",
    owner: "tts",
    introduced: "2026-04-29",
    removeAfter: "2026-07-26",
    source:
      "messages.tts.enabled, agents.list[].tts.enabled, supported channel TTS enabled fields, and voice-call plugin tts.enabled",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement:
      'supported top-level/agents/channels/plugins TTS auto mode, for example auto: "always" or auto: "off"',
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.provider-shapes.test.ts"],
  }),
  deprecatedCompatRecord("doctor-tts-speaker-selection-fields", {
    status: "removal-pending",
    owner: "tts",
    introduced: "2026-05-28",
    removeAfter: "2026-07-26",
    source: "TTS provider speaker selection fields named voice, voiceName, and voiceId",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "speakerVoice and speakerVoiceId",
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.provider-shapes.test.ts"],
  }),
  deprecatedCompatRecord("doctor-plugin-install-config-ledger", {
    status: "removal-pending",
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "plugins.installs in authored config",
    migration: "src/config/plugin-install-config-migration.ts",
    replacement: "shared SQLite installed_plugin_index install ledger",
    docsPath: "/cli/plugins#registry",
    tests: [
      "src/config/io.write-config.test.ts",
      "src/commands/doctor/shared/plugin-registry-migration.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-bundled-plugin-load-paths", {
    status: "removal-pending",
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "plugins.load.paths entries that point at bundled plugin source/dist locations",
    migration: "src/commands/doctor/shared/bundled-plugin-load-paths.ts",
    replacement: "packaged bundled plugins and the persisted plugin registry",
    docsPath: "/cli/plugins#registry",
    tests: ["src/commands/doctor/shared/bundled-plugin-load-paths.test.ts"],
  }),
  deprecatedCompatRecord("doctor-bundled-provider-discovery-allowlist", {
    status: "removal-pending",
    owner: "plugin",
    introduced: "2026-04-25",
    deprecated: "2026-04-26",
    warningStarts: "2026-04-26",
    removeAfter: "2026-07-26",
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
    removeAfter: "2026-10-09",
    source: "plugins.entries.codex-supervisor and codex-supervisor plugin policy references",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.providers.ts",
    replacement: "plugins.entries.codex.config.supervision",
    docsPath: "/plugins/codex-supervision",
    notes:
      "The core bootstrap migration must remain available when the external Codex plugin is not installed yet.",
  }),
  deprecatedCompatRecord("doctor-web-search-plugin-config", {
    status: "removal-pending",
    owner: "provider",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "tools.web.search.apiKey and tools.web.search.<provider>",
    migration: "src/commands/doctor/shared/legacy-web-search-migrate.ts",
    replacement: "plugins.entries.<plugin>.config.webSearch",
    docsPath: "/tools/web",
    tests: ["src/commands/doctor/shared/legacy-web-search-migrate.test.ts"],
    notes:
      "Provider/plugin ownership can move as bundled providers externalize; verify the current manifest owner before deleting migration support.",
  }),
  deprecatedCompatRecord("doctor-web-fetch-plugin-config", {
    status: "removal-pending",
    owner: "provider",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "tools.web.fetch.firecrawl",
    migration: "src/commands/doctor/shared/legacy-web-fetch-migrate.ts",
    replacement: "plugins.entries.firecrawl.config.webFetch",
    docsPath: "/tools/web-fetch",
    tests: ["src/commands/doctor/shared/legacy-web-fetch-migrate.test.ts"],
  }),
  deprecatedCompatRecord("doctor-x-search-plugin-config", {
    status: "removal-pending",
    owner: "provider",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "tools.web.x_search.apiKey",
    migration: "src/commands/doctor/shared/legacy-x-search-migrate.ts",
    replacement: "plugins.entries.xai.config.webSearch.apiKey",
    docsPath: "/tools/grok-search",
    tests: [
      "src/commands/doctor/shared/legacy-x-search-migrate.test.ts",
      "src/commands/doctor/shared/legacy-config-migrate.test.ts",
    ],
  }),
  deprecatedCompatRecord("doctor-talk-provider-shape", {
    status: "removal-pending",
    owner: "tts",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "legacy talk provider scalar fields and provider/provider ids",
    migration: "src/commands/doctor/shared/legacy-talk-config-normalizer.ts",
    replacement: "talk.providers.<provider>",
    docsPath: "/tools/tts",
  }),
  deprecatedCompatRecord("doctor-legacy-tools-by-sender", {
    status: "removal-pending",
    owner: "tools",
    introduced: "2026-04-26",
    removeAfter: "2026-07-26",
    source: "untyped toolsBySender keys",
    migration: "src/commands/doctor/shared/legacy-tools-by-sender.ts",
    replacement: "typed id:, e164:, username:, or name: sender keys",
    docsPath: "/tools/exec-approvals",
    tests: ["src/commands/doctor/shared/legacy-tools-by-sender.test.ts"],
  }),
] as const satisfies readonly DoctorDeprecationCompatRecord[];

export type DoctorDeprecationCompatCode =
  (typeof DOCTOR_DEPRECATION_COMPAT_RECORDS)[number]["code"];
export type KnownDoctorDeprecationCompatRecord = DoctorDeprecationCompatRecord;

const doctorDeprecationCompatRecordByCode = new Map<string, KnownDoctorDeprecationCompatRecord>(
  DOCTOR_DEPRECATION_COMPAT_RECORDS.map((record) => [record.code, record]),
);

/** List every doctor compatibility record, including removed or still-active entries. */
export function listDoctorDeprecationCompatRecords(): readonly KnownDoctorDeprecationCompatRecord[] {
  return DOCTOR_DEPRECATION_COMPAT_RECORDS;
}

/** List compatibility records currently in a deprecated/removal-pending lifecycle. */
export function listDeprecatedDoctorDeprecationCompatRecords(): readonly KnownDoctorDeprecationCompatRecord[] {
  return DOCTOR_DEPRECATION_COMPAT_RECORDS.filter((record) =>
    (["deprecated", "removal-pending"] as readonly string[]).includes(record.status),
  );
}

/** Return true when a string is a known doctor compatibility inventory code. */
export function isDoctorDeprecationCompatCode(code: string): code is DoctorDeprecationCompatCode {
  return doctorDeprecationCompatRecordByCode.has(code);
}

/** Return a doctor compatibility record by code, throwing for impossible stale callers. */
export function getDoctorDeprecationCompatRecord(
  code: DoctorDeprecationCompatCode,
): KnownDoctorDeprecationCompatRecord {
  const record = doctorDeprecationCompatRecordByCode.get(code);
  if (!record) {
    throw new Error(`Unknown doctor deprecation compatibility code: ${code}`);
  }
  return record;
}
