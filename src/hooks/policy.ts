// Hook policy helpers decide when hooks may run for a configured event.
import type { OpenClawConfig, HookConfig } from "../config/config.js";
import { resolveHookKey } from "./frontmatter.js";
import type { HookEntry, HookSource } from "./types.js";

/** Human-readable reason for disabling a hook at policy resolution time. */
export type HookEnableStateReason = "disabled in config" | "workspace hook (disabled by default)";

type HookEnableState = {
  enabled: boolean;
  reason?: HookEnableStateReason;
};

type HookSourcePolicy = {
  precedence: number;
  trustedLocalCode: boolean;
  defaultEnableMode: "default-on" | "explicit-opt-in";
  canOverride: HookSource[];
  canBeOverriddenBy: HookSource[];
};

type HookResolutionCollision = {
  name: string;
  kept: HookEntry;
  ignored: HookEntry;
};

const HOOK_SOURCE_POLICIES: Record<HookSource, HookSourcePolicy> = {
  "openclaw-bundled": {
    precedence: 10,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["openclaw-bundled"],
    canBeOverriddenBy: ["openclaw-managed", "openclaw-plugin"],
  },
  "openclaw-plugin": {
    precedence: 20,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["openclaw-bundled", "openclaw-plugin"],
    canBeOverriddenBy: ["openclaw-managed"],
  },
  "openclaw-managed": {
    precedence: 30,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["openclaw-bundled", "openclaw-managed", "openclaw-plugin"],
    canBeOverriddenBy: ["openclaw-managed"],
  },
  "openclaw-workspace": {
    precedence: 40,
    trustedLocalCode: true,
    defaultEnableMode: "explicit-opt-in",
    canOverride: ["openclaw-workspace"],
    canBeOverriddenBy: ["openclaw-workspace"],
  },
};

/** Resolve source trust, precedence, default enablement, and override rules. */
function getHookSourcePolicy(source: HookSource): HookSourcePolicy {
  return HOOK_SOURCE_POLICIES[source];
}

/** Resolve explicit per-hook config by hook key. */
export function resolveHookConfig(
  config: OpenClawConfig | undefined,
  hookKey: string,
): HookConfig | undefined {
  const hooks = config?.hooks?.internal?.entries;
  if (!hooks || typeof hooks !== "object") {
    return undefined;
  }
  const entry = (hooks as Record<string, HookConfig | undefined>)[hookKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

/** Resolve whether a hook is enabled before runtime requirement checks. */
export function resolveHookEnableState(params: {
  entry: HookEntry;
  config?: OpenClawConfig;
  hookConfig?: HookConfig;
}): HookEnableState {
  const { entry, config } = params;
  const hookKey = resolveHookKey(entry.hook.name, entry);
  const hookConfig = params.hookConfig ?? resolveHookConfig(config, hookKey);

  if (entry.hook.source === "openclaw-plugin") {
    return { enabled: true };
  }
  if (hookConfig?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }

  const sourcePolicy = getHookSourcePolicy(entry.hook.source);
  if (sourcePolicy.defaultEnableMode === "explicit-opt-in" && hookConfig?.enabled !== true) {
    return { enabled: false, reason: "workspace hook (disabled by default)" };
  }

  return { enabled: true };
}

function canOverrideHook(candidate: HookEntry, existing: HookEntry): boolean {
  const candidatePolicy = getHookSourcePolicy(candidate.hook.source);
  const existingPolicy = getHookSourcePolicy(existing.hook.source);
  return (
    candidatePolicy.canOverride.includes(existing.hook.source) &&
    existingPolicy.canBeOverriddenBy.includes(candidate.hook.source)
  );
}

/** Merge hook entries by name using source precedence and override policy. */
export function resolveHookEntries(
  entries: HookEntry[],
  opts?: {
    onCollisionIgnored?: (collision: HookResolutionCollision) => void;
  },
): HookEntry[] {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => {
      const precedenceDelta =
        getHookSourcePolicy(a.entry.hook.source).precedence -
        getHookSourcePolicy(b.entry.hook.source).precedence;
      return precedenceDelta !== 0 ? precedenceDelta : a.index - b.index;
    });

  const merged = new Map<string, HookEntry>();
  for (const { entry } of ordered) {
    const existing = merged.get(entry.hook.name);
    if (!existing) {
      merged.set(entry.hook.name, entry);
      continue;
    }
    // Source policy is asymmetric: higher precedence alone is not enough unless
    // both source policies agree the candidate may replace the existing hook.
    if (canOverrideHook(entry, existing)) {
      merged.set(entry.hook.name, entry);
      continue;
    }
    opts?.onCollisionIgnored?.({
      name: entry.hook.name,
      kept: existing,
      ignored: entry,
    });
  }

  return Array.from(merged.values());
}
