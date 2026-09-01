import type { PluginCompatRecord } from "./types.js";

type SeedFields = "code" | "owner" | "removeAfter" | "removalGate" | "replacement";
type PluginSdkSubpathSeed = Pick<PluginCompatRecord, SeedFields> &
  Record<"subpath", string> &
  Partial<Pick<PluginCompatRecord, "status" | "releaseNote">>;

const PLUGIN_SDK_SUBPATH_SEEDS = [
  {
    code: "plugin-sdk-channel-streaming-subpath",
    subpath: "channel-streaming",
    status: "removed",
    owner: "channel",
    replacement: "`openclaw/plugin-sdk/channel-outbound`",
    releaseNote:
      "The deprecated `channel-streaming` Plugin SDK subpath was removed; plugins now import channel streaming helpers from `channel-outbound`.",
  },
  {
    code: "plugin-sdk-config-runtime-subpath",
    subpath: "config-runtime",
    status: "removal-pending",
    owner: "config",
    removeAfter: "2026-09-01",
    replacement:
      "`api.pluginConfig`, `openclaw/plugin-sdk/config-mutation`, `openclaw/plugin-sdk/runtime-config-snapshot`, and `openclaw/plugin-sdk/config-contracts`; retain until supported external plugin migration is verified",
  },
  {
    code: "plugin-sdk-inbound-reply-dispatch-subpath",
    subpath: "inbound-reply-dispatch",
    owner: "channel",
    removalGate: "next-plugin-sdk-major",
    replacement: "`openclaw/plugin-sdk/channel-inbound` and `openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-channel-reply-pipeline-subpath",
    subpath: "channel-reply-pipeline",
    status: "removal-pending",
    owner: "channel",
    removeAfter: "2026-09-01",
    replacement:
      "`openclaw/plugin-sdk/channel-outbound`; retain until supported external plugin migration is verified",
  },
  {
    code: "plugin-sdk-infra-runtime-subpath",
    subpath: "infra-runtime",
    status: "removal-pending",
    owner: "sdk",
    removeAfter: "2026-09-01",
    replacement:
      "focused subpaths including `openclaw/plugin-sdk/delivery-queue-runtime`, `openclaw/plugin-sdk/diagnostic-runtime`, `openclaw/plugin-sdk/error-runtime`, `openclaw/plugin-sdk/exec-approvals-runtime`, `openclaw/plugin-sdk/fetch-runtime`, and `openclaw/plugin-sdk/ssrf-runtime`; retain until supported external plugin migration is verified and system-event snapshot inspection and consumption have a modern public replacement",
  },
  {
    code: "plugin-sdk-text-runtime-subpath",
    subpath: "text-runtime",
    status: "removed",
    owner: "sdk",
    replacement:
      "`openclaw/plugin-sdk/logging-core`, `openclaw/plugin-sdk/text-chunking`, `openclaw/plugin-sdk/text-utility-runtime`, and `openclaw/plugin-sdk/string-coerce-runtime`",
    releaseNote:
      "The deprecated `text-runtime` Plugin SDK facade was removed; plugins now import logging, chunking, text utility, and string coercion helpers from their focused subpaths.",
  },
  {
    code: "plugin-sdk-channel-secret-runtime-subpath",
    subpath: "channel-secret-runtime",
    status: "removed",
    owner: "channel",
    replacement:
      "`openclaw/plugin-sdk/channel-secret-basic-runtime` and `openclaw/plugin-sdk/channel-secret-tts-runtime`",
    releaseNote:
      "The deprecated `channel-secret-runtime` Plugin SDK subpath was removed; plugins now use the focused basic and TTS secret-runtime subpaths.",
  },
  {
    code: "plugin-sdk-agent-config-primitives-subpath",
    subpath: "agent-config-primitives",
    status: "removed",
    owner: "config",
    replacement: "`openclaw/plugin-sdk/channel-config-schema`",
    releaseNote:
      "The deprecated `agent-config-primitives` Plugin SDK subpath was removed; plugins now use maintained config-schema primitives.",
  },
  {
    code: "plugin-sdk-matrix-subpath",
    subpath: "matrix",
    status: "removed",
    owner: "channel",
    replacement: "`openclaw/plugin-sdk/run-command`",
    releaseNote:
      "The deprecated `matrix` Plugin SDK facade was removed; command execution now uses the generic `run-command` subpath.",
  },
  {
    code: "plugin-sdk-channel-logging-subpath",
    subpath: "channel-logging",
    status: "removed",
    owner: "channel",
    replacement: "`openclaw/plugin-sdk/channel-inbound` and `openclaw/plugin-sdk/channel-outbound`",
    releaseNote:
      "The deprecated `channel-logging` Plugin SDK subpath was removed; channel logging helpers now come from the inbound and outbound channel surfaces.",
  },
  {
    code: "plugin-sdk-channel-lifecycle-subpath",
    subpath: "channel-lifecycle",
    status: "removal-pending",
    owner: "channel",
    removeAfter: "2026-09-01",
    replacement:
      "`openclaw/plugin-sdk/channel-outbound`; retain until supported external plugin migration is verified",
  },
  {
    code: "plugin-sdk-channel-message-subpath",
    subpath: "channel-message",
    status: "removal-pending",
    owner: "channel",
    removeAfter: "2026-09-01",
    replacement:
      "`openclaw/plugin-sdk/channel-outbound` and `openclaw/plugin-sdk/channel-inbound`; retain until supported external plugin migration is verified",
  },
  {
    code: "plugin-sdk-group-access-subpath",
    subpath: "group-access",
    status: "removed",
    owner: "channel",
    replacement: "`openclaw/plugin-sdk/channel-ingress-runtime`",
    releaseNote:
      "The deprecated `group-access` Plugin SDK subpath was removed; plugins now resolve message admission through `channel-ingress-runtime`.",
  },
  {
    code: "plugin-sdk-zod-subpath",
    subpath: "zod",
    status: "removed",
    owner: "sdk",
    replacement: "the direct `zod` package import",
    releaseNote:
      "The deprecated `zod` Plugin SDK re-export was removed; plugins now import `zod` directly.",
  },
] as const satisfies readonly PluginSdkSubpathSeed[];

function buildPluginSdkSubpathRecord(seed: (typeof PLUGIN_SDK_SUBPATH_SEEDS)[number]) {
  // Pending removals keep their dated migration metadata; only retired paths are tombstones.
  if ("status" in seed && seed.status === "removed") {
    return {
      code: seed.code,
      status: seed.status,
      owner: seed.owner,
      introduced: "2026-07-06",
      replacement: seed.replacement,
      docsPath: "/plugins/sdk-migration",
      surfaces: [`openclaw/plugin-sdk/${seed.subpath}`],
      diagnostics: ["plugin SDK compatibility registry and migration guide"],
      tests: ["src/plugins/compat/registry.test.ts"],
      releaseNote: seed.releaseNote,
    } satisfies PluginCompatRecord;
  }

  return {
    code: seed.code,
    status: "status" in seed ? seed.status : "deprecated",
    owner: seed.owner,
    introduced: "2026-07-06",
    deprecated: "2026-07-06",
    warningStarts: "2026-07-06",
    removeAfter: "removeAfter" in seed ? seed.removeAfter : undefined,
    removalGate: "removalGate" in seed ? seed.removalGate : undefined,
    replacement: seed.replacement,
    docsPath: "/plugins/sdk-migration",
    surfaces: [`openclaw/plugin-sdk/${seed.subpath}`],
    diagnostics: [
      "repository deprecated API usage guard for core and bundled plugins; no external runtime import warning",
    ],
    tests: ["src/plugins/compat/registry.test.ts"],
  } satisfies PluginCompatRecord;
}

export const PLUGIN_SDK_SUBPATH_RECORDS = PLUGIN_SDK_SUBPATH_SEEDS.map(
  buildPluginSdkSubpathRecord,
) satisfies readonly PluginCompatRecord[];

const BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_SEEDS = [
  {
    subpath: "media-understanding",
    status: "removal-pending",
    removeAfter: "2026-09-30",
    replacement:
      "`api.registerMediaUnderstandingProvider(...)` with provider-owned request helpers and types from `openclaw/plugin-sdk/plugin-entry`; retain the public subpath through the 2026-09-30 window while official plugin consumers migrate",
    docsPath: "/plugins/architecture",
  },
  {
    subpath: "memory-host-core",
    status: "removal-pending",
    removeAfter: "2026-09-30",
    replacement:
      "host-prepared memory prompts via `openclaw/plugin-sdk/core` and memory capability registration through the injected plugin API; retain the facade through the 2026-09-30 window and until a focused public-artifact read seam exists",
    docsPath: "/plugins/architecture-internals#context-engine-plugins",
  },
  {
    subpath: "plugin-config-runtime",
    status: "removal-pending",
    removeAfter: "2026-12-01",
    replacement:
      "`api.pluginConfig`, runtime tool context config, and focused `config-contracts`, `runtime-config-snapshot`, or `config-mutation` subpaths; retain the public subpath through the 2026-12-01 window while official plugin consumers migrate",
    docsPath: "/plugins/sdk-runtime",
  },
  {
    subpath: "tool-plugin",
    status: "deprecated",
    replacement:
      "retain the public subpath until plugin authoring has a nonexecuting static metadata replacement for `defineToolPlugin`; `getToolPluginMetadata` currently reads metadata only from an already-executed entry",
    docsPath: "/plugins/tool-plugins",
  },
] as const;

function buildPublicSdkSubpathRecord({
  subpath,
  ...compat
}: (typeof BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_SEEDS)[number]) {
  return {
    code: `plugin-sdk-${subpath}-public-demotion` as const,
    owner: "sdk" as const,
    introduced: "2026-07-15",
    deprecated: "2026-07-15",
    warningStarts: "2026-07-15",
    ...compat,
    surfaces: [`openclaw/plugin-sdk/${subpath}`],
    diagnostics: ["registry-backed public SDK demotion window; no external runtime import warning"],
    tests: ["src/plugins/compat/registry.test.ts"],
  } satisfies PluginCompatRecord;
}

export const BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS =
  BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_SEEDS.map(buildPublicSdkSubpathRecord);
