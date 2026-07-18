/**
 * Claude CLI setup migration helpers. They rewrite legacy Claude CLI model refs
 * to Anthropic refs while preserving runtime allowlist entries for CLI execution.
 */
import {
  CLAUDE_CLI_PROFILE_ID,
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveClaudeCliAnthropicModelRefs } from "./claude-model-refs.js";
import type { readClaudeCliCredentialsForSetup } from "./cli-auth-seam.js";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS } from "./cli-shared.js";

type AgentDefaultsModel = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["model"];
type AgentDefaultsModels = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;

function toAnthropicModelRef(raw: string): string | null {
  return resolveClaudeCliAnthropicModelRefs(raw)?.rewriteRef ?? null;
}

function toAnthropicRuntimeRefs(raw: string): string[] {
  return resolveClaudeCliAnthropicModelRefs(raw)?.runtimeRefs ?? [];
}

function toAnthropicSelectedModelRef(raw: string): string | undefined {
  const resolved = resolveClaudeCliAnthropicModelRefs(raw);
  return resolved?.rewriteRef ?? resolved?.selectedRef;
}

function rewriteModelSelection(model: AgentDefaultsModel): {
  value: AgentDefaultsModel;
  primary?: string;
  runtimeRefs: string[];
  changed: boolean;
} {
  if (typeof model === "string") {
    const runtimeRefs = toAnthropicRuntimeRefs(model);
    const converted = toAnthropicModelRef(model);
    const selectedRef = converted ?? toAnthropicSelectedModelRef(model);
    return converted
      ? { value: converted, primary: converted, runtimeRefs, changed: true }
      : {
          value: model,
          ...(selectedRef ? { primary: selectedRef } : {}),
          runtimeRefs,
          changed: false,
        };
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return { value: model, runtimeRefs: [], changed: false };
  }

  const current = model as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  const runtimeRefs: string[] = [];
  let changed = false;
  let primary: string | undefined;

  if (typeof current.primary === "string") {
    runtimeRefs.push(...toAnthropicRuntimeRefs(current.primary));
    const converted = toAnthropicModelRef(current.primary);
    if (converted) {
      next.primary = converted;
      primary = converted;
      changed = true;
    } else {
      primary = toAnthropicSelectedModelRef(current.primary);
    }
  }

  const currentFallbacks = current.fallbacks;
  if (Array.isArray(currentFallbacks)) {
    const nextFallbacks = currentFallbacks.map((entry) => {
      if (typeof entry !== "string") {
        return entry;
      }
      runtimeRefs.push(...toAnthropicRuntimeRefs(entry));
      const converted = toAnthropicModelRef(entry);
      return converted ?? entry;
    });
    if (nextFallbacks.some((entry, index) => entry !== currentFallbacks[index])) {
      next.fallbacks = nextFallbacks;
      changed = true;
    }
  }

  return {
    value: changed ? next : model,
    ...(primary ? { primary } : {}),
    runtimeRefs,
    changed,
  };
}

function rewriteModelEntryMap(models: Record<string, unknown> | undefined): {
  value: Record<string, unknown> | undefined;
  migrated: string[];
  runtimeRefs: string[];
} {
  if (!models) {
    return { value: models, migrated: [], runtimeRefs: [] };
  }

  const next = { ...models };
  const migrated: string[] = [];
  const runtimeRefs: string[] = [];

  for (const [rawKey, value] of Object.entries(models)) {
    runtimeRefs.push(...toAnthropicRuntimeRefs(rawKey));
    const converted = toAnthropicModelRef(rawKey);
    if (!converted) {
      continue;
    }
    if (converted === rawKey) {
      continue;
    }
    if (!(converted in next)) {
      next[converted] = value;
    }
    if (normalizeLowercaseStringOrEmpty(rawKey).startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)) {
      delete next[rawKey];
    }
    migrated.push(converted);
  }

  return {
    value: migrated.length > 0 || runtimeRefs.length > 0 ? next : models,
    migrated,
    runtimeRefs,
  };
}

function seedClaudeCliAllowlist(
  models: NonNullable<AgentDefaultsModels>,
  selectedRefs: readonly string[] = [],
): NonNullable<AgentDefaultsModels> {
  const next = { ...models };
  const runtimeRefs = new Set<string>();
  for (const ref of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
    const canonicalRef = toAnthropicModelRef(ref) ?? ref;
    runtimeRefs.add(canonicalRef);
  }
  for (const ref of selectedRefs) {
    runtimeRefs.add(ref);
  }
  for (const ref of runtimeRefs) {
    next[ref] = modelEntryWithClaudeCliRuntime(next[ref]);
  }
  return next;
}

function modelEntryWithClaudeCliRuntime(entry: unknown): Record<string, unknown> {
  const base = isRecord(entry) ? { ...entry } : {};
  const currentRuntimeId = isRecord(base.agentRuntime) ? base.agentRuntime.id : undefined;
  const currentRuntime =
    typeof currentRuntimeId === "string" ? normalizeLowercaseStringOrEmpty(currentRuntimeId) : "";
  if (currentRuntime && currentRuntime !== "auto") {
    return base;
  }
  base.agentRuntime = {
    ...(isRecord(base.agentRuntime) ? base.agentRuntime : {}),
    id: CLAUDE_CLI_BACKEND_ID,
  };
  return base;
}

function buildClaudeCliAuthProfiles(
  credential?: ClaudeCliCredential | null,
): ProviderAuthResult["profiles"] {
  if (!credential) {
    return [];
  }
  if (credential.type === "oauth") {
    return [
      {
        profileId: CLAUDE_CLI_PROFILE_ID,
        credential: {
          type: "oauth",
          provider: CLAUDE_CLI_BACKEND_ID,
          access: credential.access,
          refresh: credential.refresh,
          expires: credential.expires,
        },
      },
    ];
  }
  if (credential.type === "api_key_helper") {
    return [];
  }
  return [
    {
      profileId: CLAUDE_CLI_PROFILE_ID,
      credential: {
        type: "token",
        provider: CLAUDE_CLI_BACKEND_ID,
        token: credential.token,
        expires: credential.expires,
      },
    },
  ];
}

/** Build the config migration result for adopting Claude CLI-backed Anthropic defaults. */
export function buildAnthropicCliMigrationResult(
  config: OpenClawConfig,
  credential?: ClaudeCliCredential | null,
): ProviderAuthResult {
  const defaults = config.agents?.defaults;
  const rewrittenModel = rewriteModelSelection(defaults?.model);
  const rewrittenModels = rewriteModelEntryMap(defaults?.models);
  const existingModels = (rewrittenModels.value ??
    defaults?.models ??
    {}) as NonNullable<AgentDefaultsModels>;
  const nextModels = seedClaudeCliAllowlist(existingModels, [
    ...rewrittenModel.runtimeRefs,
    ...rewrittenModels.runtimeRefs,
    ...rewrittenModels.migrated,
  ]);
  const defaultModel = rewrittenModel.primary ?? "anthropic/claude-opus-4-8";

  return {
    profiles: buildClaudeCliAuthProfiles(credential),
    configPatch: {
      agents: {
        defaults: {
          ...(rewrittenModel.changed ? { model: rewrittenModel.value } : {}),
          models: nextModels,
        },
      },
    },
    // Rewrites `claude-cli/*` -> `anthropic/*`; merge would keep stale keys.
    replaceDefaultModels: true,
    defaultModel,
    notes: [
      "Claude CLI auth detected; kept Anthropic model refs and selected the local Claude CLI runtime.",
      "Existing Anthropic auth profiles are kept for rollback.",
      ...(rewrittenModels.migrated.length > 0
        ? [`Migrated allowlist entries: ${rewrittenModels.migrated.join(", ")}.`]
        : []),
    ],
  };
}
