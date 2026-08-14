// System-agent config redaction keeps model-visible reads and plans aligned with config UI hints.
import {
  hasSensitiveUrlHintTag,
  isSensitiveUrlConfigPath,
  redactSensitiveUrlLikeString,
} from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseConfigSetPath, parseConfigSetValue } from "../cli/config-cli-path.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "../config/channel-config-metadata.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../config/redact-snapshot.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { buildConfigSchemaCore } from "../config/schema.js";
import { findWildcardHintMatch } from "../config/schema.shared.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";
import type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

type SystemAgentConfigRedactionSource = {
  config?: OpenClawConfig;
  valid?: boolean;
};

type SystemAgentConfigRedactionMetadata = {
  uiHints: ConfigUiHints;
  pluginIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
};

const baseConfigRedactionMetadata: SystemAgentConfigRedactionMetadata = {
  uiHints: buildConfigSchemaCore().uiHints,
  pluginIds: new Set(),
  channelIds: new Set(),
};
const metadataConfigRedaction = new WeakMap<
  PluginMetadataSnapshot,
  SystemAgentConfigRedactionMetadata
>();

function resolveMetadataConfigRedaction(
  snapshot: PluginMetadataSnapshot,
): SystemAgentConfigRedactionMetadata {
  const cached = metadataConfigRedaction.get(snapshot);
  if (cached) {
    return cached;
  }
  const plugins = collectPluginSchemaMetadataCore(snapshot.manifestRegistry);
  const channels = collectChannelSchemaMetadataCore(snapshot.manifestRegistry);
  const metadata = {
    uiHints: buildConfigSchemaCore({ plugins, channels }).uiHints,
    pluginIds: new Set(plugins.map((plugin) => normalizePluginPolicyId(plugin.id))),
    channelIds: new Set(channels.map((channel) => channel.id)),
  };
  metadataConfigRedaction.set(snapshot, metadata);
  return metadata;
}

function resolveSystemAgentConfigRedactionMetadata(
  source?: SystemAgentConfigRedactionSource,
): SystemAgentConfigRedactionMetadata {
  if (source?.valid === false) {
    return baseConfigRedactionMetadata;
  }
  const config = source?.config ?? getRuntimeConfigSnapshot();
  if (!config) {
    return baseConfigRedactionMetadata;
  }
  // Gateway lifecycle owns this process-stable snapshot. A mismatch is unknown
  // metadata, never a reason to rediscover plugins from a model-visible hot path.
  const snapshot = getCurrentPluginMetadataSnapshot({
    config,
    env: process.env,
    allowWorkspaceScopedSnapshot: true,
  });
  return snapshot ? resolveMetadataConfigRedaction(snapshot) : baseConfigRedactionMetadata;
}

function splitConfigHintPath(path: string): string[] {
  // Schema hint paths use `[]` as an array wildcard; config writes spell the
  // same segment as `[*]`.
  return parseConfigSetPath(path.replace(/\[\]/g, "[*]"));
}

function resolveConfigUiHint(
  path: readonly string[],
  uiHints: ConfigUiHints,
  includeAncestors = false,
  acceptHint?: (hint: ConfigUiHint) => boolean,
): ConfigUiHint | undefined {
  return (
    findWildcardHintMatch({
      uiHints,
      path: path.join("."),
      // Config path segments can themselves contain dots. Preserve the
      // writer-parsed boundaries instead of reparsing a lossy joined path.
      targetParts: path,
      splitPath: splitConfigHintPath,
      includeAncestors,
      acceptHint,
    })?.hint ?? undefined
  );
}

function isUnknownDynamicOwnerPath(
  path: readonly string[],
  metadata: SystemAgentConfigRedactionMetadata,
): boolean {
  if (path[0] === "plugins" && path[1] === "entries" && path[2] && path[3] === "config") {
    return !metadata.pluginIds.has(normalizePluginPolicyId(path[2]));
  }
  return path[0] === "channels" && Boolean(path[1]) && !metadata.channelIds.has(path[1]);
}

function hasSensitiveConfigValue(
  path: string[],
  value: unknown,
  metadata: SystemAgentConfigRedactionMetadata,
): boolean {
  if (isUnknownDynamicOwnerPath(path, metadata)) {
    return true;
  }
  const { uiHints } = metadata;
  const canonicalPath = path.join(".");
  const sensitiveHint = resolveConfigUiHint(
    path,
    uiHints,
    true,
    (candidate) => candidate.sensitive !== undefined,
  );
  if (sensitiveHint?.sensitive === true || isSensitiveConfigPath(canonicalPath)) {
    return true;
  }
  const hint = resolveConfigUiHint(path, uiHints);
  if (
    typeof value === "string" &&
    (hasSensitiveUrlHintTag(hint) || isSensitiveUrlConfigPath(canonicalPath)) &&
    redactSensitiveUrlLikeString(value) !== value
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry, index) =>
      hasSensitiveConfigValue([...path, String(index)], entry, metadata),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) =>
      hasSensitiveConfigValue([...path, key], entry, metadata),
    );
  }
  return false;
}

/** Return whether a config value must stay out of model-visible command text. */
export function isSystemAgentSensitiveConfigValue(path: string, value: unknown): boolean {
  let parsedPath: string[];
  try {
    parsedPath = parseConfigSetPath(path);
  } catch {
    // The command parser accepts a broader path surface than config writes do.
    // Keep malformed paths out of model-visible text instead of guessing how a
    // future writer or normalizer might interpret them.
    return true;
  }
  const parsedValue = typeof value === "string" ? parseConfigSetValue(value, false) : value;
  return hasSensitiveConfigValue(
    parsedPath,
    parsedValue,
    resolveSystemAgentConfigRedactionMetadata(),
  );
}

function redactUnknownDynamicOwners(
  value: unknown,
  metadata: SystemAgentConfigRedactionMetadata,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  let result = value;
  const plugins = isRecord(value.plugins) ? value.plugins : undefined;
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : undefined;
  if (entries) {
    let redactedEntries: Record<string, unknown> | undefined;
    for (const [pluginId, entry] of Object.entries(entries)) {
      if (
        metadata.pluginIds.has(normalizePluginPolicyId(pluginId)) ||
        !isRecord(entry) ||
        !Object.hasOwn(entry, "config")
      ) {
        continue;
      }
      redactedEntries ??= { ...entries };
      redactedEntries[pluginId] = { ...entry, config: REDACTED_SENTINEL };
    }
    if (redactedEntries) {
      result = {
        ...result,
        plugins: { ...plugins, entries: redactedEntries },
      };
    }
  }

  const channels = isRecord(value.channels) ? value.channels : undefined;
  if (channels) {
    let redactedChannels: Record<string, unknown> | undefined;
    for (const channelId of Object.keys(channels)) {
      if (metadata.channelIds.has(channelId)) {
        continue;
      }
      redactedChannels ??= { ...channels };
      redactedChannels[channelId] = REDACTED_SENTINEL;
    }
    if (redactedChannels) {
      result = { ...result, channels: redactedChannels };
    }
  }
  return result;
}

function replaceRedactionSentinels(value: unknown): unknown {
  if (value === REDACTED_SENTINEL) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map(replaceRedactionSentinels);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceRedactionSentinels(entry)]),
    );
  }
  return value;
}

/** Redact a config object before any subtree is projected into a model-visible result. */
export function redactSystemAgentConfig(
  value: unknown,
  source?: SystemAgentConfigRedactionSource,
): unknown {
  const metadata = resolveSystemAgentConfigRedactionMetadata(source);
  return replaceRedactionSentinels(
    redactConfigObject(redactUnknownDynamicOwners(value, metadata), metadata.uiHints),
  );
}
