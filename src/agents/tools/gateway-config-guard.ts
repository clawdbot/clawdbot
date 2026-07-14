import { isDeepStrictEqual } from "node:util";
import { isRecord as isPlainObject } from "@openclaw/normalization-core/record-coerce";
import { parseConfigJson5 } from "../../config/io.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { collectEnabledInsecureOrDangerousFlags } from "../../security/dangerous-config-flags.js";

// `assertGatewayConfigMutationAllowed` is the explicit model -> operator
// trust-boundary control on `config.apply`/`config.patch`, so the runtime tool
// must fail closed and allow only a narrow set of agent-tunable paths.
const ALLOWED_GATEWAY_CONFIG_PATHS = [
  // Low-risk agent runtime tuning.
  // agents.list[].model is allowed below; the defaults-shape spelling of the
  // same capability must match or allowlisting depends on config shape.
  "agents.defaults.model",
  "agents.defaults.thinkingDefault",
  "agents.defaults.subagents.thinking",
  "agents.defaults.reasoningDefault",
  "agents.defaults.fastModeDefault",
  "agents.list[].id",
  "agents.list[].model",
  "agents.list[].thinkingDefault",
  "agents.list[].subagents.thinking",
  "agents.list[].reasoningDefault",
  "agents.list[].fastModeDefault",
  // Mention gating is an agent-facing scope knob across channel adapters.
  // Depths here must cover the deepest `requireMention` path the channel
  // adapters use today — Telegram topic overrides live at
  // `channels.telegram.groups.<group>.topics.<topic>.requireMention`.
  "channels.*.requireMention",
  "channels.*.*.requireMention",
  "channels.*.*.*.requireMention",
  "channels.*.*.*.*.requireMention",
  "channels.*.*.*.*.*.requireMention",
  // Visible reply delivery mode is a bounded message UX setting, not a secret
  // or privilege boundary. Let agents repair silent group/channel rooms.
  "messages.visibleReplies",
  "messages.groupChat.visibleReplies",
  "messages.groupChat.unmentionedInbound",
] as const;

/** @internal Exposed for regression tests only; do not import from runtime code. */
export function assertGatewayConfigMutationAllowedForTest(params: {
  action: "config.apply" | "config.patch";
  currentConfig: Record<string, unknown>;
  raw: string;
  replacePaths?: string[];
}): void {
  assertGatewayConfigMutationAllowed(params);
}

function parseGatewayConfigMutationRaw(
  raw: string,
  action: "config.apply" | "config.patch",
): unknown {
  const parsedRes = parseConfigJson5(raw);
  if (!parsedRes.ok) {
    throw new Error(parsedRes.error);
  }
  if (
    !parsedRes.parsed ||
    typeof parsedRes.parsed !== "object" ||
    Array.isArray(parsedRes.parsed)
  ) {
    throw new Error(`${action} raw must be an object.`);
  }
  return parsedRes.parsed;
}

function normalizeGatewayConfigPath(path: string): string {
  return path.startsWith("tools.bash.") ? path.replace(/^tools\.bash\./, "tools.exec.") : path;
}

function readKeyedArrayEntries(list: unknown): {
  duplicateIds: boolean;
  entries: Map<string, unknown>;
  hasUnkeyedEntries: boolean;
} | null {
  if (!Array.isArray(list)) {
    return null;
  }

  let duplicateIds = false;
  let hasUnkeyedEntries = false;
  const entries = new Map<string, unknown>();
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      hasUnkeyedEntries = true;
      continue;
    }
    if (entries.has(entry.id)) {
      duplicateIds = true;
      continue;
    }
    entries.set(entry.id, entry);
  }
  return { duplicateIds, entries, hasUnkeyedEntries };
}

function collectConfigLeafPaths(value: unknown, basePath: string, out: Set<string>): void {
  const canonicalPath = normalizeGatewayConfigPath(basePath);
  if (value === undefined) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  if (Array.isArray(value)) {
    const keyedEntries = readKeyedArrayEntries(value);
    if (
      keyedEntries &&
      !keyedEntries.duplicateIds &&
      !keyedEntries.hasUnkeyedEntries &&
      keyedEntries.entries.size > 0
    ) {
      for (const entryValue of keyedEntries.entries.values()) {
        collectConfigLeafPaths(entryValue, `${basePath}[]`, out);
      }
      return;
    }
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  if (!isPlainObject(value)) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  for (const [key, child] of entries) {
    collectConfigLeafPaths(child, basePath ? `${basePath}.${key}` : key, out);
  }
}

function collectChangedConfigPaths(
  currentValue: unknown,
  nextValue: unknown,
  basePath = "",
  out = new Set<string>(),
): Set<string> {
  if (isDeepStrictEqual(currentValue, nextValue)) {
    return out;
  }

  if (currentValue === undefined || nextValue === undefined) {
    collectConfigLeafPaths(currentValue ?? nextValue, basePath, out);
    return out;
  }

  if (Array.isArray(currentValue) || Array.isArray(nextValue)) {
    if (!Array.isArray(currentValue) || !Array.isArray(nextValue)) {
      collectConfigLeafPaths(currentValue, basePath, out);
      collectConfigLeafPaths(nextValue, basePath, out);
      return out;
    }

    const currentEntries = readKeyedArrayEntries(currentValue);
    const nextEntries = readKeyedArrayEntries(nextValue);
    if (
      !currentEntries ||
      !nextEntries ||
      currentEntries.duplicateIds ||
      nextEntries.duplicateIds ||
      currentEntries.hasUnkeyedEntries ||
      nextEntries.hasUnkeyedEntries
    ) {
      out.add(normalizeGatewayConfigPath(basePath));
      return out;
    }

    const ids = new Set([...currentEntries.entries.keys(), ...nextEntries.entries.keys()]);
    for (const id of ids) {
      collectChangedConfigPaths(
        currentEntries.entries.get(id),
        nextEntries.entries.get(id),
        `${basePath}[]`,
        out,
      );
    }
    return out;
  }

  if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
    const keys = new Set([...Object.keys(currentValue), ...Object.keys(nextValue)]);
    for (const key of keys) {
      collectChangedConfigPaths(
        currentValue[key],
        nextValue[key],
        basePath ? `${basePath}.${key}` : key,
        out,
      );
    }
    return out;
  }

  out.add(normalizeGatewayConfigPath(basePath));
  return out;
}

function pathSegmentMatches(patternSegment: string, pathSegment: string): boolean {
  return patternSegment === "*" || patternSegment === pathSegment;
}

function isAllowedGatewayConfigPath(path: string): boolean {
  const pathSegments = path.split(".");
  return ALLOWED_GATEWAY_CONFIG_PATHS.some((pattern) => {
    const patternSegments = pattern.split(".");
    if (patternSegments.length > pathSegments.length) {
      return false;
    }
    for (let i = 0; i < patternSegments.length; i += 1) {
      const patternSegment = patternSegments.at(i);
      const pathSegment = pathSegments.at(i);
      if (!patternSegment || !pathSegment || !pathSegmentMatches(patternSegment, pathSegment)) {
        return false;
      }
    }
    return true;
  });
}

export function assertGatewayConfigMutationAllowed(params: {
  action: "config.apply" | "config.patch";
  currentConfig: Record<string, unknown>;
  raw: string;
  replacePaths?: string[];
}): void {
  const parsed = parseGatewayConfigMutationRaw(params.raw, params.action);
  const nextConfig =
    params.action === "config.apply"
      ? (parsed as Record<string, unknown>)
      : (applyMergePatch(params.currentConfig, parsed, {
          mergeObjectArraysById: true,
          replaceArrayPaths: new Set(params.replacePaths ?? []),
        }) as Record<string, unknown>);
  const changedPaths = [...collectChangedConfigPaths(params.currentConfig, nextConfig)].toSorted();
  const disallowedPaths = changedPaths.filter((path) => !isAllowedGatewayConfigPath(path));
  if (disallowedPaths.length > 0) {
    throw new Error(
      `gateway ${params.action} cannot change protected config paths: ${disallowedPaths.join(", ")}. ` +
        "Agent config writes are restricted to a fixed allowlist as an injection boundary; " +
        "sender identity or user authorization cannot widen it, so do not retry or ask for approval. " +
        "The operator must change protected paths outside the agent (openclaw.json or openclaw configure). " +
        `Agent-tunable paths: ${ALLOWED_GATEWAY_CONFIG_PATHS.join(", ")}`,
    );
  }

  // Block writes that newly enable any dangerous config flag.
  // Uses the same flag enumeration as `openclaw security audit`.
  const currentFlags = new Set(
    collectEnabledInsecureOrDangerousFlags(params.currentConfig as OpenClawConfig),
  );
  const nextFlags = collectEnabledInsecureOrDangerousFlags(nextConfig as OpenClawConfig);
  const newlyEnabled = nextFlags.filter((f) => !currentFlags.has(f));
  if (newlyEnabled.length > 0) {
    throw new Error(
      `gateway ${params.action} cannot enable dangerous config flags: ${newlyEnabled.join(", ")}`,
    );
  }
}
