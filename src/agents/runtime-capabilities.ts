import {
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "../channels/thread-bindings-policy.js";
import { resolveChannelCapabilities } from "../config/channel-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveChannelPromptCapabilities } from "./channel-tools.js";

const THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY = "threadbound-subagent-spawn";
const THREAD_BOUND_ACP_SPAWN_CAPABILITY = "threadbound-acp-spawn";

function mergeRuntimeCapabilities(
  base?: readonly string[] | null,
  additions: readonly string[] = [],
): string[] | undefined {
  const merged = [...(base ?? [])];
  const seen = new Set(
    merged.map((capability) => normalizeOptionalLowercaseString(capability)).filter(Boolean),
  );

  for (const capability of additions) {
    const normalizedCapability = normalizeOptionalLowercaseString(capability);
    if (!normalizedCapability || seen.has(normalizedCapability)) {
      continue;
    }
    seen.add(normalizedCapability);
    merged.push(capability);
  }

  return merged.length > 0 ? merged : undefined;
}

export function collectRuntimeChannelCapabilities(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  if (!params.channel) {
    return undefined;
  }
  const threadSpawnCapabilities: string[] = [];
  if (params.cfg && supportsAutomaticThreadBindingSpawn(params.channel)) {
    for (const [kind, capability] of [
      ["subagent", THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY],
      ["acp", THREAD_BOUND_ACP_SPAWN_CAPABILITY],
    ] as const) {
      const policy = resolveThreadBindingSpawnPolicy({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId ?? undefined,
        kind,
      });
      if (policy.enabled && policy.spawnEnabled) {
        threadSpawnCapabilities.push(capability);
      }
    }
  }
  return mergeRuntimeCapabilities(
    resolveChannelCapabilities(params),
    params.cfg
      ? [...resolveChannelPromptCapabilities(params), ...threadSpawnCapabilities]
      : threadSpawnCapabilities,
  );
}
