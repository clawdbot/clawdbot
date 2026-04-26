import type { PluginCompatRecord } from "./types.js";

export const PLUGIN_COMPAT_RECORDS = [
  {
    code: "legacy-before-agent-start",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-04-24",
    deprecated: "2026-04-24",
    warningStarts: "2026-04-24",
    replacement: "`before_model_resolve` and `before_prompt_build` hooks",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["plugin hooks", "plugins inspect", "status diagnostics"],
    diagnostics: ["plugin compatibility notice"],
    tests: ["src/plugins/status.test.ts", "src/plugins/contracts/shape.contract.test.ts"],
    releaseNote:
      "Legacy `before_agent_start` hook compatibility remains wired while plugins migrate to modern hook stages.",
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
    code: "legacy-root-sdk-import",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-04-24",
    deprecated: "2026-04-24",
    warningStarts: "2026-04-24",
    replacement: "focused `openclaw/plugin-sdk/<subpath>` imports",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["openclaw/plugin-sdk", "openclaw/plugin-sdk/compat"],
    diagnostics: ["OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED"],
    tests: [
      "src/plugins/contracts/plugin-sdk-index.test.ts",
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
    code: "provider-auth-env-vars",
    status: "deprecated",
    owner: "setup",
    introduced: "2026-04-24",
    deprecated: "2026-04-24",
    warningStarts: "2026-04-24",
    replacement: "`setup.providers[].envVars` and `providerAuthChoices`",
    docsPath: "/plugins/manifest",
    surfaces: ["openclaw.plugin.json providerAuthEnvVars", "provider setup"],
    diagnostics: ["manifest compatibility diagnostic"],
    tests: ["src/plugins/setup-registry.test.ts", "src/plugins/provider-auth-choices.test.ts"],
  },
  {
    code: "channel-env-vars",
    status: "deprecated",
    owner: "channel",
    introduced: "2026-04-24",
    deprecated: "2026-04-24",
    warningStarts: "2026-04-24",
    replacement: "`channelConfigs.<id>.schema` and setup descriptors",
    docsPath: "/plugins/manifest",
    surfaces: ["openclaw.plugin.json channelEnvVars", "channel setup"],
    diagnostics: ["manifest compatibility diagnostic"],
    tests: [
      "src/plugins/setup-registry.test.ts",
      "src/channels/plugins/setup-group-access.test.ts",
    ],
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
    code: "embedded-harness-config-alias",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-04-24",
    deprecated: "2026-04-25",
    warningStarts: "2026-04-25",
    replacement: "`agentRuntime` config naming",
    docsPath: "/plugins/sdk-agent-harness",
    surfaces: ["agents.defaults.embeddedHarness", "model/provider runtime selection"],
    diagnostics: ["agent runtime config compatibility"],
    tests: ["src/agents/config.test.ts", "src/agents/runtime-selection.test.ts"],
  },
  {
    code: "agent-harness-sdk-alias",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-04-24",
    deprecated: "2026-04-25",
    warningStarts: "2026-04-25",
    replacement: "`openclaw/plugin-sdk/agent-runtime`",
    docsPath: "/plugins/sdk-agent-harness",
    surfaces: ["openclaw/plugin-sdk/agent-harness", "openclaw/plugin-sdk/agent-harness-runtime"],
    diagnostics: ["plugin SDK compatibility warning"],
    tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"],
  },
  {
    code: "agent-harness-id-alias",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-04-24",
    deprecated: "2026-04-25",
    warningStarts: "2026-04-25",
    replacement: "`agentRuntime` ids and policy metadata",
    docsPath: "/plugins/sdk-agent-harness",
    surfaces: ["manifest/catalog execution policy", "runtime selection"],
    diagnostics: ["agent runtime compatibility warning"],
    tests: ["src/plugins/provider-runtime.test.ts", "src/web/provider-runtime-shared.test.ts"],
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
    code: "disable-persisted-plugin-registry-env",
    status: "deprecated",
    owner: "config",
    introduced: "2026-04-25",
    deprecated: "2026-04-25",
    warningStarts: "2026-04-25",
    replacement: "`openclaw plugins registry --refresh` and `openclaw doctor --fix`",
    docsPath: "/cli/plugins#registry",
    surfaces: ["OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY", "plugin registry reads"],
    diagnostics: ["persisted-registry-disabled"],
    tests: ["src/plugins/plugin-registry.test.ts"],
  },
] as const satisfies readonly PluginCompatRecord[];

export type PluginCompatCode = (typeof PLUGIN_COMPAT_RECORDS)[number]["code"];
export type KnownPluginCompatRecord = PluginCompatRecord<PluginCompatCode>;

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

export function isPluginCompatCode(code: string): code is PluginCompatCode {
  return pluginCompatRecordByCode.has(code as PluginCompatCode);
}

export function listDeprecatedPluginCompatRecords(): readonly KnownPluginCompatRecord[] {
  return PLUGIN_COMPAT_RECORDS.filter((record) =>
    (["deprecated", "removal-pending"] as readonly string[]).includes(record.status),
  );
}
