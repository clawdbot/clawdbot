// System-agent config redaction keeps model-visible reads and plans aligned with config UI hints.
import {
  hasSensitiveUrlHintTag,
  isSensitiveUrlConfigPath,
  redactSensitiveUrlLikeString,
} from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CHANNEL_IDS } from "../channels/ids.js";
import { parseConfigSetPath, parseConfigSetValue } from "../cli/config-cli-path.js";
import { isKernelOwnedChannelConfigKey } from "../config/channel-config-keys.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "../config/channel-config-metadata.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../config/redact-snapshot.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  buildConfigSchemaCore,
  classifyConfigSchemaPathSegment,
  type ConfigSchemaResponse,
} from "../config/schema.js";
import { findWildcardHintMatch } from "../config/schema.shared.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ChannelsSchema } from "../config/zod-schema.channels-config.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";
import type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

type SystemAgentConfigRedactionSource = {
  config?: OpenClawConfig;
  valid?: boolean;
};

type SystemAgentConfigRedactionMetadata = {
  schema: ConfigSchemaResponse;
  uiHints: ConfigUiHints;
  sensitiveHintPaths: readonly (readonly string[])[];
  wildcardHintPaths: readonly (readonly string[])[];
  pluginIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
};

const baseConfigSchema = buildConfigSchemaCore();
// These sensitive fields are maps whose child keys are operator labels, not secrets.
const SENSITIVE_CONFIG_CONTAINER_KEYS = new Set(["env", "headers"]);
function collectUiHintPaths(
  uiHints: ConfigUiHints,
  accept: (hint: ConfigUiHint, parts: readonly string[]) => boolean,
): readonly (readonly string[])[] {
  return Object.entries(uiHints).flatMap(([path, hint]) => {
    if (!path) {
      return [];
    }
    const parts = splitConfigHintPath(path);
    return accept(hint, parts) ? [parts] : [];
  });
}

const baseConfigRedactionMetadata: SystemAgentConfigRedactionMetadata = {
  schema: baseConfigSchema,
  uiHints: baseConfigSchema.uiHints,
  sensitiveHintPaths: collectUiHintPaths(
    baseConfigSchema.uiHints,
    (hint) => hint.sensitive === true || hasSensitiveUrlHintTag(hint),
  ),
  wildcardHintPaths: collectUiHintPaths(baseConfigSchema.uiHints, (_hint, parts) =>
    parts.includes("*"),
  ),
  pluginIds: new Set(),
  channelIds: new Set(CHANNEL_IDS),
};
const invalidConfigRedactionMetadata: SystemAgentConfigRedactionMetadata = {
  ...baseConfigRedactionMetadata,
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
  const schema = buildConfigSchemaCore({ plugins, channels });
  const uiHints = schema.uiHints;
  const metadata = {
    schema,
    uiHints,
    sensitiveHintPaths: collectUiHintPaths(
      uiHints,
      (hint) => hint.sensitive === true || hasSensitiveUrlHintTag(hint),
    ),
    wildcardHintPaths: collectUiHintPaths(uiHints, (_hint, parts) => parts.includes("*")),
    pluginIds: new Set(
      plugins
        .filter((plugin) => plugin.configSchema !== undefined)
        .map((plugin) => normalizePluginPolicyId(plugin.id)),
    ),
    channelIds: new Set([
      ...CHANNEL_IDS,
      ...channels
        .filter((channel) => channel.configSchema !== undefined)
        .map((channel) => channel.id),
    ]),
  };
  metadataConfigRedaction.set(snapshot, metadata);
  return metadata;
}

function resolveSystemAgentConfigRedactionMetadata(
  source?: SystemAgentConfigRedactionSource,
): SystemAgentConfigRedactionMetadata {
  if (source?.valid === false) {
    return invalidConfigRedactionMetadata;
  }
  const config = source?.config ?? getRuntimeConfigSnapshot();
  if (!config) {
    const snapshot = getCurrentPluginMetadataSnapshot({
      env: process.env,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    return snapshot ? resolveMetadataConfigRedaction(snapshot) : baseConfigRedactionMetadata;
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
  const pluginId = path[2];
  if (path[0] === "plugins" && path[1] === "entries" && pluginId && path[3] === "config") {
    return !metadata.pluginIds.has(normalizePluginPolicyId(pluginId));
  }
  const channelId = path[1];
  if (path[0] === "channels" && channelId) {
    const knownOwner =
      isKernelOwnedChannelConfigKey(channelId) || metadata.channelIds.has(channelId);
    return !knownOwner;
  }
  return false;
}

function isDynamicOwnerIdSegment(path: readonly string[], index: number): boolean {
  return (
    (path[0] === "channels" && index === 1) ||
    (path[0] === "plugins" && path[1] === "entries" && index === 2)
  );
}

function hasSensitiveHintSegmentPrefix(
  path: readonly string[],
  index: number,
  metadata: SystemAgentConfigRedactionMetadata,
): boolean {
  const segment = path[index];
  if (segment === undefined) {
    return false;
  }
  for (let end = 1; end < segment.length; end += 1) {
    const prefixPath = [...path.slice(0, index), segment.slice(0, end)];
    if (metadata.sensitiveHintPaths.some((hintPath) => matchesHintPath(hintPath, prefixPath))) {
      return true;
    }
  }
  return false;
}

function isKernelPassthroughSegment(path: readonly string[], index: number): boolean {
  return (
    (path[0] === "hooks" && path[1] === "entries" && (index === 2 || index === 3)) ||
    (path[0] === "talk" && path[1] === "providers" && (index === 2 || index === 3))
  );
}

function isSchemaDynamicSegment(
  path: readonly string[],
  index: number,
  metadata: SystemAgentConfigRedactionMetadata,
): boolean {
  // The UI schema intentionally strips kernel channel fields. Preserve the
  // two record-key levels owned by the canonical modelByChannel schema here.
  if (path[0] === "channels" && path[1] === "modelByChannel" && (index === 2 || index === 3)) {
    return true;
  }
  // Zod passthrough/catchall objects become untyped in the public form schema.
  // These exact core containers still own arbitrary entry ids and child keys.
  if (isKernelPassthroughSegment(path, index)) {
    return !hasSensitiveHintSegmentPrefix(path, index, metadata);
  }
  const segment = path[index];
  if (segment === undefined) {
    return false;
  }
  const kind = classifyConfigSchemaPathSegment(metadata.schema, path.slice(0, index), segment);
  if (kind === "record-key" || kind === "array-index") {
    return !hasSensitiveHintSegmentPrefix(path, index, metadata);
  }
  if (kind === "invalid-record-key") {
    return false;
  }
  if (
    classifyConfigSchemaPathSegment(metadata.schema, path.slice(0, index), "0") === "array-index"
  ) {
    return false;
  }
  // Some plugin UI schemas intentionally describe only their security-owned
  // leaves. A later fixed hint still proves the wildcard container boundary.
  return metadata.wildcardHintPaths.some(
    (hintParts) =>
      hintParts[index] === "*" &&
      hintParts.slice(index + 1).some((part) => part !== "*") &&
      hintParts
        .slice(0, index)
        .every((part, partIndex) => part === "*" || part === path[partIndex]),
  );
}

function matchesHintPath(pattern: readonly string[], path: readonly string[]): boolean {
  return (
    pattern.length === path.length &&
    pattern.every((part, index) => part === "*" || part === path[index])
  );
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

function isSensitiveConfigPathParts(
  path: string[],
  metadata: SystemAgentConfigRedactionMetadata,
  includeAncestors = true,
): boolean {
  const { uiHints } = metadata;
  const canonicalPath = path.join(".");
  const sensitiveHint = resolveConfigUiHint(
    path,
    uiHints,
    includeAncestors,
    (candidate) => candidate.sensitive !== undefined,
  );
  if (sensitiveHint?.sensitive === true || isSensitiveConfigPath(canonicalPath)) {
    return true;
  }
  const hint = resolveConfigUiHint(path, uiHints);
  return hasSensitiveUrlHintTag(hint) || isSensitiveUrlConfigPath(canonicalPath);
}

function hasSensitiveSegmentPrefix(
  parsedPath: string[],
  index: number,
  metadata: SystemAgentConfigRedactionMetadata,
): boolean {
  const segment = parsedPath[index];
  if (segment === undefined) {
    return false;
  }
  for (let end = 1; end < segment.length; end += 1) {
    const prefixPath = [...parsedPath.slice(0, index), segment.slice(0, end)];
    const canonicalPath = prefixPath.join(".");
    if (
      isSensitiveConfigPath(canonicalPath) ||
      isSensitiveUrlConfigPath(canonicalPath) ||
      metadata.sensitiveHintPaths.some((hintPath) => matchesHintPath(hintPath, prefixPath))
    ) {
      return true;
    }
  }
  return false;
}

function hasSensitiveContainerAssignment(path: readonly string[], index: number): boolean {
  return (
    SENSITIVE_CONFIG_CONTAINER_KEYS.has(path[index - 1] ?? "") &&
    (path[index]?.includes("=") ?? false)
  );
}

/** Redact unknown-owner paths and data appended after a sensitive key. */
export function redactSystemAgentConfigPath(path: string): string {
  try {
    const parsedPath = parseConfigSetPath(path);
    const metadata = resolveSystemAgentConfigRedactionMetadata();
    const hasSensitivePathData = parsedPath.some(
      (segment, index) =>
        hasSensitiveContainerAssignment(parsedPath, index) ||
        (!isDynamicOwnerIdSegment(parsedPath, index) &&
          !isSchemaDynamicSegment(parsedPath, index, metadata) &&
          (segment.includes("=") ||
            (!SENSITIVE_CONFIG_CONTAINER_KEYS.has(parsedPath[index - 1] ?? "") &&
              hasSensitiveSegmentPrefix(parsedPath, index, metadata)))) ||
        (index > 0 &&
          !SENSITIVE_CONFIG_CONTAINER_KEYS.has(parsedPath[index - 1] ?? "") &&
          isSensitiveConfigPathParts(parsedPath.slice(0, index), metadata)),
    );
    return isUnknownDynamicOwnerPath(parsedPath, metadata) || hasSensitivePathData
      ? "<redacted path>"
      : path;
  } catch {
    return "<redacted path>";
  }
}

/** Return whether a path segment embeds data after a sensitive config key. */
export function isSystemAgentSensitiveConfigPathEmbedding(path: string): boolean {
  let parsedPath: string[];
  try {
    parsedPath = parseConfigSetPath(path);
  } catch {
    return true;
  }
  const metadata = resolveSystemAgentConfigRedactionMetadata();
  const unknownOwner = isUnknownDynamicOwnerPath(parsedPath, metadata);
  return parsedPath.some((segment, index) => {
    if (unknownOwner && segment.includes("=")) {
      return true;
    }
    if (hasSensitiveContainerAssignment(parsedPath, index)) {
      return true;
    }
    if (
      isDynamicOwnerIdSegment(parsedPath, index) ||
      SENSITIVE_CONFIG_CONTAINER_KEYS.has(parsedPath[index - 1] ?? "") ||
      isSchemaDynamicSegment(parsedPath, index, metadata)
    ) {
      return false;
    }
    return segment.includes("=") || hasSensitiveSegmentPrefix(parsedPath, index, metadata);
  });
}

function redactUnknownDynamicOwners(
  value: unknown,
  metadata: SystemAgentConfigRedactionMetadata,
  invalidConfig: boolean,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  let result = value;
  const plugins = isRecord(value.plugins) ? value.plugins : undefined;
  if (invalidConfig && Object.hasOwn(value, "plugins") && !plugins) {
    result = { ...result, plugins: REDACTED_SENTINEL };
  }
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : undefined;
  if (invalidConfig && plugins && Object.hasOwn(plugins, "entries") && !entries) {
    result = { ...result, plugins: { ...plugins, entries: REDACTED_SENTINEL } };
  }
  if (entries) {
    let redactedEntries: Record<string, unknown> | undefined;
    for (const [pluginId, entry] of Object.entries(entries)) {
      if (!isRecord(entry) || !Object.hasOwn(entry, "config")) {
        if (invalidConfig) {
          redactedEntries ??= { ...entries };
          redactedEntries[pluginId] = REDACTED_SENTINEL;
        }
        continue;
      }
      if (metadata.pluginIds.has(normalizePluginPolicyId(pluginId))) {
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
  if (invalidConfig && Object.hasOwn(value, "channels") && !channels) {
    result = { ...result, channels: REDACTED_SENTINEL };
  }
  if (channels) {
    let redactedChannels: Record<string, unknown> | undefined;
    for (const [channelId, channelConfig] of Object.entries(channels)) {
      if (isKernelOwnedChannelConfigKey(channelId)) {
        if (invalidConfig) {
          redactedChannels ??= { ...channels };
          redactedChannels[channelId] = redactInvalidKernelChannelConfig(channelId, channelConfig);
        }
        continue;
      }
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

function redactInvalidKernelChannelConfig(key: string, value: unknown): unknown {
  if (key === "modelByChannel") {
    return ChannelsSchema.safeParse({ modelByChannel: value }).success ? value : REDACTED_SENTINEL;
  }
  if (key !== "defaults" || !isRecord(value)) {
    return REDACTED_SENTINEL;
  }
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => [
      field,
      ChannelsSchema.safeParse({ defaults: { [field]: entry } }).success
        ? entry
        : REDACTED_SENTINEL,
    ]),
  );
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
    redactConfigObject(
      redactUnknownDynamicOwners(value, metadata, source?.valid === false),
      metadata.uiHints,
    ),
  );
}
