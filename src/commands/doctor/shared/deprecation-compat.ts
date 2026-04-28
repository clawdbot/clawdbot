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
  code: Code;
  status: DoctorDeprecationCompatStatus;
  owner: DoctorDeprecationCompatOwner;
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

const TODAY = "2026-04-26";
const MAX_REMOVE_AFTER = "2026-07-26";

function deprecatedCompatRecord<Code extends string>(
  record: Omit<
    DoctorDeprecationCompatRecord<Code>,
    "deprecated" | "warningStarts" | "removeAfter" | "status"
  > &
    Partial<
      Pick<
        DoctorDeprecationCompatRecord<Code>,
        "deprecated" | "removeAfter" | "status" | "warningStarts"
      >
    >,
): DoctorDeprecationCompatRecord<Code> {
  return {
    status: "deprecated",
    deprecated: TODAY,
    warningStarts: TODAY,
    removeAfter: MAX_REMOVE_AFTER,
    ...record,
  };
}

// Doctor migrations and repair shims can outlive the runtime/config compatibility
// path they repair. Release removals must check this inventory before deleting
// doctor fixes, and replacement notes should be revalidated against the current
// architecture because ownership and config footprint can shift during rollout.
export const DOCTOR_DEPRECATION_COMPAT_RECORDS = [
  deprecatedCompatRecord({
    code: "doctor-agent-llm-timeout",
    owner: "agent-runtime",
    introduced: "2026-04-27",
    source: "agents.defaults.llm.idleTimeoutSeconds",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "models.providers.<id>.timeoutSeconds",
    docsPath: "/gateway/config-agents",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
    notes:
      "The old agent-level idle timeout knob was collapsed into provider request timeout handling.",
  }),
  deprecatedCompatRecord({
    code: "doctor-agent-runtime-embedded-harness",
    owner: "agent-runtime",
    introduced: "2026-04-25",
    source: "agents.defaults.embeddedHarness; agents.list[].embeddedHarness",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.agentRuntime and agents.list[].agentRuntime",
    docsPath: "/plugins/sdk-agent-harness",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
    notes:
      "Runtime-policy naming changed during the plugin architecture work; verify replacement wording against current agentRuntime docs before removal.",
  }),
  deprecatedCompatRecord({
    code: "doctor-agent-sandbox-persession",
    owner: "agent-runtime",
    introduced: "2026-04-26",
    source: "agents.defaults.sandbox.perSession; agents.list[].sandbox.perSession",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.*.sandbox.scope",
    docsPath: "/cli/doctor",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-top-level-memory-search",
    owner: "config",
    introduced: "2026-04-26",
    source: "memorySearch",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.memorySearch",
    docsPath: "/cli/doctor",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-top-level-heartbeat",
    owner: "config",
    introduced: "2026-04-26",
    source: "heartbeat",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts",
    replacement: "agents.defaults.heartbeat and channels.defaults.heartbeat",
    docsPath: "/automation",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-mcp-server-type-alias",
    owner: "config",
    introduced: "2026-04-27",
    source: "mcp.servers.*.type",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.mcp.ts",
    replacement: "mcp.servers.*.transport",
    docsPath: "/cli/mcp",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
    notes:
      "OpenClaw stores transport names; CLI backends receive their own type fields through runtime adapters.",
  }),
  deprecatedCompatRecord({
    code: "doctor-gateway-bind-host-aliases",
    owner: "gateway",
    introduced: "2026-04-26",
    source: "gateway.bind host aliases such as 0.0.0.0 and localhost",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.gateway.ts",
    replacement: "gateway.bind.mode values such as lan, loopback, custom, tailnet, and auto",
    docsPath: "/gateway/configuration",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-audio-transcription-command",
    owner: "audio",
    introduced: "2026-04-26",
    source: "audio.transcription",
    migration: "src/commands/doctor/shared/legacy-config-migrations.audio.ts",
    replacement: "tools.media.audio.models",
    docsPath: "/tools/media-overview",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-channel-thread-binding-ttl",
    owner: "channel",
    introduced: "2026-04-26",
    source: "threadBindings.ttlHours",
    migration: "src/commands/doctor/shared/legacy-config-migrations.channels.ts",
    replacement: "threadBindings.idleHours",
    docsPath: "/channels/channel-routing",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-channel-dm-aliases",
    owner: "channel",
    introduced: "2026-04-26",
    source: "channels.<id>.dm.policy and channels.<id>.dm.allowFrom",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.dmPolicy and channels.<id>.allowFrom",
    docsPath: "/channels/channel-routing",
    tests: ["src/commands/doctor/shared/channel-legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-channel-streaming-aliases",
    owner: "channel",
    introduced: "2026-04-26",
    source: "streamMode, scalar streaming, chunkMode, blockStreaming, draftChunk, nativeStreaming",
    migration: "src/config/channel-compat-normalization.ts",
    replacement: "channels.<id>.streaming.*",
    docsPath: "/channels/channel-routing",
    tests: ["src/commands/doctor/shared/channel-legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-tts-provider-aliases",
    owner: "tts",
    introduced: "2026-04-26",
    source: "messages.tts.openai/elevenlabs/edge and plugins.entries.voice-call.config.tts aliases",
    migration: "src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts",
    replacement: "messages.tts.providers.<provider> and microsoft instead of edge",
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-plugin-install-config-ledger",
    owner: "plugin",
    introduced: "2026-04-25",
    source: "plugins.installs in authored config",
    migration: "src/config/plugin-install-config-migration.ts",
    replacement: "state-managed plugins/installs.json install ledger",
    docsPath: "/cli/plugins#registry",
    tests: [
      "src/config/io.write-config.test.ts",
      "src/commands/doctor/shared/plugin-registry-migration.test.ts",
    ],
  }),
  deprecatedCompatRecord({
    code: "doctor-bundled-plugin-load-paths",
    owner: "plugin",
    introduced: "2026-04-25",
    source: "plugins.load.paths entries that point at bundled plugin source/dist locations",
    migration: "src/commands/doctor/shared/bundled-plugin-load-paths.ts",
    replacement: "packaged bundled plugins and the persisted plugin registry",
    docsPath: "/cli/plugins#registry",
    tests: ["src/commands/doctor/shared/bundled-plugin-load-paths.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-web-search-plugin-config",
    owner: "provider",
    introduced: "2026-04-26",
    source: "tools.web.search.apiKey and tools.web.search.<provider>",
    migration: "src/commands/doctor/shared/legacy-web-search-migrate.ts",
    replacement: "plugins.entries.<plugin>.config.webSearch",
    docsPath: "/tools/web",
    tests: ["src/commands/doctor/shared/legacy-web-search-migrate.test.ts"],
    notes:
      "Provider/plugin ownership can move as bundled providers externalize; verify the current manifest owner before deleting migration support.",
  }),
  deprecatedCompatRecord({
    code: "doctor-web-fetch-plugin-config",
    owner: "provider",
    introduced: "2026-04-26",
    source: "tools.web.fetch.firecrawl",
    migration: "src/commands/doctor/shared/legacy-web-fetch-migrate.ts",
    replacement: "plugins.entries.firecrawl.config.webFetch",
    docsPath: "/tools/web-fetch",
    tests: ["src/commands/doctor/shared/legacy-web-fetch-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-x-search-plugin-config",
    owner: "provider",
    introduced: "2026-04-26",
    source: "tools.web.x_search.apiKey",
    migration: "src/commands/doctor/shared/legacy-x-search-migrate.ts",
    replacement: "plugins.entries.xai.config.webSearch.apiKey",
    docsPath: "/tools/grok-search",
    tests: [
      "src/commands/doctor/shared/legacy-x-search-migrate.test.ts",
      "src/commands/doctor/shared/legacy-config-migrate.test.ts",
    ],
  }),
  deprecatedCompatRecord({
    code: "doctor-talk-provider-shape",
    owner: "tts",
    introduced: "2026-04-26",
    source: "legacy talk provider scalar fields and provider/provider ids",
    migration: "src/commands/doctor/shared/legacy-talk-config-normalizer.ts",
    replacement: "talk.providers.<provider>",
    docsPath: "/tools/tts",
    tests: ["src/commands/doctor/shared/legacy-config-migrate.test.ts"],
  }),
  deprecatedCompatRecord({
    code: "doctor-legacy-tools-by-sender",
    owner: "tools",
    introduced: "2026-04-26",
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

const doctorDeprecationCompatRecordByCode = new Map<
  DoctorDeprecationCompatCode,
  KnownDoctorDeprecationCompatRecord
>(DOCTOR_DEPRECATION_COMPAT_RECORDS.map((record) => [record.code, record]));

export function listDoctorDeprecationCompatRecords(): readonly KnownDoctorDeprecationCompatRecord[] {
  return DOCTOR_DEPRECATION_COMPAT_RECORDS;
}

export function listDeprecatedDoctorDeprecationCompatRecords(): readonly KnownDoctorDeprecationCompatRecord[] {
  return DOCTOR_DEPRECATION_COMPAT_RECORDS.filter((record) =>
    (["deprecated", "removal-pending"] as readonly string[]).includes(record.status),
  );
}

export function isDoctorDeprecationCompatCode(code: string): code is DoctorDeprecationCompatCode {
  return doctorDeprecationCompatRecordByCode.has(code);
}

export function getDoctorDeprecationCompatRecord(
  code: DoctorDeprecationCompatCode,
): KnownDoctorDeprecationCompatRecord {
  const record = doctorDeprecationCompatRecordByCode.get(code);
  if (!record) {
    throw new Error(`Unknown doctor deprecation compatibility code: ${code}`);
  }
  return record;
}
