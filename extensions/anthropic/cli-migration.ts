import {
  CLAUDE_CLI_PROFILE_ID,
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readClaudeCliCredentialsForSetup,
  readClaudeCliCredentialsForSetupNonInteractive,
} from "./cli-auth-seam.js";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS } from "./cli-shared.js";

type AgentDefaultsModel = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["model"];
type AgentDefaultsModels = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
type AgentDefaultsRuntimePolicy = NonNullable<
  NonNullable<OpenClawConfig["agents"]>["defaults"]
>["agentRuntime"];
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;

function toAnthropicModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const provider = lower.startsWith("anthropic/")
    ? "anthropic"
    : lower.startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)
      ? CLAUDE_CLI_BACKEND_ID
      : "";
  if (!provider) {
    return null;
  }
  const modelId = trimmed.slice(provider.length + 1).trim();
  if (!normalizeLowercaseStringOrEmpty(modelId).startsWith("claude-")) {
    return null;
  }
  return `anthropic/${modelId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rewriteModelSelection(model: AgentDefaultsModel): {
  value: AgentDefaultsModel;
  primary?: string;
  runtimeRefs: string[];
  changed: boolean;
} {
  if (typeof model === "string") {
    const converted = toAnthropicModelRef(model);
    return converted
      ? { value: converted, primary: converted, runtimeRefs: [converted], changed: true }
      : { value: model, runtimeRefs: [], changed: false };
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
    const converted = toAnthropicModelRef(current.primary);
    if (converted) {
      next.primary = converted;
      primary = converted;
      runtimeRefs.push(converted);
      changed = true;
    }
  }

  const currentFallbacks = current.fallbacks;
  if (Array.isArray(currentFallbacks)) {
    const nextFallbacks = currentFallbacks.map((entry) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const converted = toAnthropicModelRef(entry);
      if (converted) {
        runtimeRefs.push(converted);
      }
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
} {
  if (!models) {
    return { value: models, migrated: [] };
  }

  const next = { ...models };
  const migrated: string[] = [];

  for (const [rawKey, value] of Object.entries(models)) {
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
    delete next[rawKey];
    migrated.push(converted);
  }

  return {
    value: migrated.length > 0 ? next : models,
    migrated,
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

function selectClaudeCliRuntime(agentRuntime: AgentDefaultsRuntimePolicy | undefined) {
  const currentRuntime = agentRuntime?.id?.trim();
  if (currentRuntime && currentRuntime !== "auto") {
    return agentRuntime;
  }
  return {
    ...agentRuntime,
    id: CLAUDE_CLI_BACKEND_ID,
  };
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

export function hasClaudeCliAuth(options?: { allowKeychainPrompt?: boolean }): boolean {
  return Boolean(
    options?.allowKeychainPrompt === false
      ? readClaudeCliCredentialsForSetupNonInteractive()
      : readClaudeCliCredentialsForSetup(),
  );
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
    ...rewrittenModels.migrated,
  ]);
  const defaultModel = rewrittenModel.primary ?? "anthropic/claude-opus-4-7";

  return {
    profiles: buildClaudeCliAuthProfiles(credential),
    configPatch: {
      agents: {
        defaults: {
          ...(rewrittenModel.changed ? { model: rewrittenModel.value } : {}),
          agentRuntime: selectClaudeCliRuntime(defaults?.agentRuntime),
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
