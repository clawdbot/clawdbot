// Session patch applier for gateway session metadata and model/runtime overrides.
import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../agents/inherited-tool-deny.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  resolveSupportedThinkingLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeExecTarget } from "../infra/exec-approvals.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import { parseSessionLabel, SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";

function invalid(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message) };
}

function normalizeExecSecurity(raw: string): "deny" | "allowlist" | "full" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

function normalizeExecAsk(raw: string): "off" | "on-miss" | "always" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return undefined;
}

function shouldPreserveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  currentProvider: string;
  provider: string;
}): boolean {
  const profileOverride = normalizeOptionalString(params.entry.authProfileOverride);
  if (!profileOverride) {
    return false;
  }
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (!provider) {
    return false;
  }
  const resolvesToTargetProvider = (rawProvider: string | undefined): boolean => {
    const candidate = normalizeOptionalLowercaseString(rawProvider);
    if (!candidate) {
      return false;
    }
    return (
      resolveProviderIdForAuth(candidate, { config: params.cfg }) ===
      resolveProviderIdForAuth(provider, { config: params.cfg })
    );
  };
  const delimiterIndex = profileOverride.indexOf(":");
  if (delimiterIndex < 0) {
    return resolvesToTargetProvider(params.currentProvider);
  }
  const profileProvider = normalizeOptionalLowercaseString(
    profileOverride.slice(0, delimiterIndex),
  );
  if (!profileProvider) {
    return false;
  }
  return resolvesToTargetProvider(profileProvider);
}

function supportsSpawnLineage(storeKey: string): boolean {
  return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}

function normalizeSubagentRole(raw: string): "orchestrator" | "leaf" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "orchestrator" || normalized === "leaf") {
    return normalized;
  }
  return undefined;
}

function normalizeSubagentControlScope(raw: string): "children" | "none" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "children" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

type SessionPatchProjectionEntry = {
  entry: SessionEntry;
  sessionKey: string;
};

/** Project a validated gateway session patch for one session entry. */
export async function projectSessionsPatchEntry(params: {
  cfg: OpenClawConfig;
  entries: readonly SessionPatchProjectionEntry[];
  existingEntry?: SessionEntry;
  storeKey: string;
  agentId?: string;
  patch: SessionsPatchParams;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const { cfg, storeKey, patch } = params;
  const now = Date.now();
  const parsedAgent = parseAgentSessionKey(storeKey);
  const sessionAgentId = normalizeAgentId(
    params.agentId ?? parsedAgent?.agentId ?? resolveDefaultAgentId(cfg),
  );
  const resolvedDefault = resolveDefaultModelForAgent({ cfg, agentId: sessionAgentId });
  const subagentModelHint = isSubagentSessionKey(storeKey)
    ? resolveSubagentConfiguredModelSelection({ cfg, agentId: sessionAgentId })
    : undefined;
  const resolveThinkingRuntime = (
    provider: string,
    model: string,
    entry?: SessionEntry,
  ): string => {
    // ACP metadata can own canonical agent keys (for example agent:main:main),
    // so key shape alone cannot identify the runtime that validates thinking.
    const acpMeta = readAcpSessionMetaForEntry({ sessionKey: storeKey, entry });
    return (
      acpMeta?.backend ??
      resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId: sessionAgentId,
        sessionKey: storeKey,
        sessionEntry: entry,
      })
    );
  };
  let loadedModelCatalog: ModelCatalogEntry[] | undefined;
  const loadModelCatalogForPatch = async () => {
    if (loadedModelCatalog) {
      return loadedModelCatalog;
    }
    if (!params.loadGatewayModelCatalog) {
      return undefined;
    }
    const catalog = await params.loadGatewayModelCatalog();
    loadedModelCatalog = Array.isArray(catalog) ? catalog : [];
    return loadedModelCatalog;
  };

  const existing = params.existingEntry;
  // Existing entries without session ids are placeholder aliases; assigning an id makes them real.
  const next: SessionEntry = existing?.sessionId
    ? {
        ...existing,
        updatedAt: Math.max(existing.updatedAt ?? 0, now),
      }
    : {
        ...existing,
        sessionId: randomUUID(),
        sessionFile: undefined,
        updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      };
  if (existing && !existing.sessionId) {
    delete next.label;
    delete next.category;
    delete next.displayName;
  }

  type PatchError = ReturnType<typeof invalid> | null;
  const checkSpawnLineage = (field: string): PatchError =>
    supportsSpawnLineage(storeKey)
      ? null
      : invalid(`${field} is only supported for subagent:* or acp:* sessions`);
  const applyImmutableString = (
    field: "spawnedBy" | "spawnedWorkspaceDir" | "spawnedCwd",
    checkLineageBeforeEmpty: boolean,
  ): PatchError => {
    if (!(field in patch)) {
      return null;
    }
    const raw = patch[field];
    if (raw === null) {
      return existing?.[field] ? invalid(`${field} cannot be cleared once set`) : null;
    }
    if (raw === undefined) {
      return null;
    }
    const earlyLineage = checkLineageBeforeEmpty ? checkSpawnLineage(field) : null;
    if (earlyLineage) {
      return earlyLineage;
    }
    const trimmed = normalizeOptionalString(raw) ?? "";
    if (!trimmed) {
      return invalid(`invalid ${field}: empty`);
    }
    const lateLineage = checkLineageBeforeEmpty ? null : checkSpawnLineage(field);
    if (lateLineage) {
      return lateLineage;
    }
    if (existing?.[field] && existing[field] !== trimmed) {
      return invalid(`${field} cannot be changed once set`);
    }
    next[field] = trimmed;
    return null;
  };
  const applyImmutableNormalized = <T extends "subagentRole" | "subagentControlScope">(
    field: T,
    normalize: (raw: string) => NonNullable<SessionEntry[T]> | undefined,
    invalidMessage: string,
  ): PatchError => {
    if (!(field in patch)) {
      return null;
    }
    const raw = patch[field];
    if (raw === null) {
      return existing?.[field] ? invalid(`${field} cannot be cleared once set`) : null;
    }
    if (raw === undefined) {
      return null;
    }
    const lineage = checkSpawnLineage(field);
    if (lineage) {
      return lineage;
    }
    const normalized = normalize(raw);
    if (!normalized) {
      return invalid(invalidMessage);
    }
    if (existing?.[field] && existing[field] !== normalized) {
      return invalid(`${field} cannot be changed once set`);
    }
    next[field] = normalized;
    return null;
  };

  for (const fieldParams of [
    { field: "spawnedBy" as const, checkLineageBeforeEmpty: false },
    { field: "spawnedWorkspaceDir" as const, checkLineageBeforeEmpty: true },
    { field: "spawnedCwd" as const, checkLineageBeforeEmpty: true },
  ]) {
    const result = applyImmutableString(fieldParams.field, fieldParams.checkLineageBeforeEmpty);
    if (result) {
      return result;
    }
  }

  if ("spawnDepth" in patch) {
    const raw = patch.spawnDepth;
    if (raw === null) {
      if (typeof existing?.spawnDepth === "number") {
        return invalid("spawnDepth cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnDepth is only supported for subagent:* or acp:* sessions");
      }
      const numeric = raw;
      if (!Number.isInteger(numeric) || numeric < 0) {
        return invalid("invalid spawnDepth (use an integer >= 0)");
      }
      const normalized = numeric;
      if (typeof existing?.spawnDepth === "number" && existing.spawnDepth !== normalized) {
        return invalid("spawnDepth cannot be changed once set");
      }
      next.spawnDepth = normalized;
    }
  }

  for (const fieldParams of [
    {
      field: "subagentRole" as const,
      normalize: normalizeSubagentRole,
      invalidMessage: 'invalid subagentRole (use "orchestrator" or "leaf")',
    },
    {
      field: "subagentControlScope" as const,
      normalize: normalizeSubagentControlScope,
      invalidMessage: 'invalid subagentControlScope (use "children" or "none")',
    },
  ]) {
    const result = applyImmutableNormalized(
      fieldParams.field,
      fieldParams.normalize,
      fieldParams.invalidMessage,
    );
    if (result) {
      return result;
    }
  }

  if ("inheritedToolDeny" in patch) {
    const raw = patch.inheritedToolDeny;
    if (raw === null) {
      delete next.inheritedToolDeny;
    } else if (raw !== undefined) {
      if (!Array.isArray(raw)) {
        return invalid("invalid inheritedToolDeny (use an array of tool names)");
      }
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("inheritedToolDeny is only supported for subagent:* or acp:* sessions");
      }
      const inheritedToolDeny = normalizeInheritedToolDenylist(raw);
      if (inheritedToolDeny.length > 0) {
        next.inheritedToolDeny = inheritedToolDeny;
      } else {
        delete next.inheritedToolDeny;
      }
    }
  }

  if ("inheritedToolAllow" in patch) {
    const raw = patch.inheritedToolAllow;
    if (raw === null) {
      delete next.inheritedToolAllow;
    } else if (raw !== undefined) {
      if (!Array.isArray(raw)) {
        return invalid("invalid inheritedToolAllow (use an array of tool names)");
      }
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("inheritedToolAllow is only supported for subagent:* or acp:* sessions");
      }
      const inheritedToolAllow = normalizeInheritedToolAllowlist(raw);
      if (inheritedToolAllow.length > 0) {
        next.inheritedToolAllow = inheritedToolAllow;
      } else {
        delete next.inheritedToolAllow;
      }
    }
  }

  if ("label" in patch) {
    const raw = patch.label;
    if (raw === null) {
      delete next.label;
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) {
        return invalid(parsed.error);
      }
      for (const { sessionKey, entry } of params.entries) {
        if (sessionKey === storeKey) {
          continue;
        }
        if (entry?.label === parsed.label) {
          return invalid(`label already in use: ${parsed.label}`);
        }
      }
      next.label = parsed.label;
    }
  }

  if ("category" in patch) {
    const raw = patch.category;
    if (raw === null) {
      delete next.category;
    } else if (raw !== undefined) {
      // Categories are shared organization buckets, so duplicates are expected (unlike labels).
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid category: empty");
      }
      if (trimmed.length > SESSION_LABEL_MAX_LENGTH) {
        return invalid(`invalid category: too long (max ${SESSION_LABEL_MAX_LENGTH})`);
      }
      next.category = trimmed;
    }
  }

  if ("archived" in patch) {
    if (patch.archived === true) {
      // Archived sessions leave the active quick-access set in the same write.
      next.archivedAt ??= now;
      delete next.pinnedAt;
    } else {
      delete next.archivedAt;
    }
  }

  if ("pinned" in patch) {
    if (patch.pinned === true) {
      if (next.archivedAt !== undefined) {
        return invalid("cannot pin an archived session; restore it first");
      }
      next.pinnedAt ??= now;
    } else {
      delete next.pinnedAt;
    }
  }

  if ("unread" in patch) {
    if (patch.unread === true) {
      next.markedUnreadAt = now;
    } else {
      next.lastReadAt = now;
      delete next.markedUnreadAt;
    }
  }

  if ("thinkingLevel" in patch) {
    const raw = patch.thinkingLevel;
    if (raw === null) {
      // Clear the override and fall back to model default
      delete next.thinkingLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeThinkLevel(raw);
      if (!normalized) {
        const hintProvider =
          normalizeOptionalString(existing?.providerOverride) || resolvedDefault.provider;
        const hintModel = normalizeOptionalString(existing?.modelOverride) || resolvedDefault.model;
        const thinkingCatalog = await loadModelCatalogForPatch();
        const thinkingRuntime = resolveThinkingRuntime(hintProvider, hintModel, existing);
        return invalid(
          `invalid thinkingLevel (use ${formatThinkingLevels(hintProvider, hintModel, "|", thinkingCatalog, thinkingRuntime)})`,
        );
      }
      next.thinkingLevel = normalized;
    }
  }

  if ("fastMode" in patch) {
    const raw = patch.fastMode;
    if (raw === null) {
      delete next.fastMode;
    } else if (raw !== undefined) {
      const normalized = normalizeFastMode(raw);
      if (normalized === undefined) {
        return invalid('invalid fastMode (use true, false, or "auto")');
      }
      next.fastMode = normalized;
    }
  }

  if ("verboseLevel" in patch) {
    const raw = patch.verboseLevel;
    const parsed = parseVerboseOverride(raw);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyVerboseOverride(next, parsed.value);
  }

  if ("traceLevel" in patch) {
    const raw = patch.traceLevel;
    const parsed = parseTraceOverride(raw);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyTraceOverride(next, parsed.value);
  }

  if ("reasoningLevel" in patch) {
    const raw = patch.reasoningLevel;
    if (raw === null) {
      delete next.reasoningLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeReasoningLevel(raw);
      if (!normalized) {
        return invalid('invalid reasoningLevel (use "on"|"off"|"stream")');
      }
      // Persist "off" explicitly so that resolveDefaultReasoningLevel()
      // does not re-enable reasoning for capable models (#24406).
      next.reasoningLevel = normalized;
    }
  }

  if ("responseUsage" in patch) {
    const raw = patch.responseUsage;
    if (raw === null) {
      delete next.responseUsage;
    } else if (raw !== undefined) {
      const normalized = normalizeUsageDisplay(raw);
      if (!normalized) {
        return invalid('invalid responseUsage (use "off"|"tokens"|"full")');
      }
      next.responseUsage = normalized;
    }
  }

  if ("elevatedLevel" in patch) {
    const raw = patch.elevatedLevel;
    if (raw === null) {
      delete next.elevatedLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeElevatedLevel(raw);
      if (!normalized) {
        return invalid('invalid elevatedLevel (use "on"|"off"|"ask"|"full")');
      }
      // Persist "off" explicitly so patches can override defaults.
      next.elevatedLevel = normalized;
    }
  }

  if ("execHost" in patch) {
    const raw = patch.execHost;
    if (raw === null) {
      delete next.execHost;
    } else if (raw !== undefined) {
      const normalized = normalizeExecTarget(raw) ?? undefined;
      if (!normalized) {
        return invalid('invalid execHost (use "auto"|"sandbox"|"gateway"|"node")');
      }
      next.execHost = normalized;
    }
  }

  if ("execSecurity" in patch) {
    const raw = patch.execSecurity;
    if (raw === null) {
      delete next.execSecurity;
    } else if (raw !== undefined) {
      const normalized = normalizeExecSecurity(raw);
      if (!normalized) {
        return invalid('invalid execSecurity (use "deny"|"allowlist"|"full")');
      }
      next.execSecurity = normalized;
    }
  }

  if ("execAsk" in patch) {
    const raw = patch.execAsk;
    if (raw === null) {
      delete next.execAsk;
    } else if (raw !== undefined) {
      const normalized = normalizeExecAsk(raw);
      if (!normalized) {
        return invalid('invalid execAsk (use "off"|"on-miss"|"always")');
      }
      next.execAsk = normalized;
    }
  }

  if ("execNode" in patch) {
    const raw = patch.execNode;
    if (raw === null) {
      delete next.execNode;
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid execNode: empty");
      }
      next.execNode = trimmed;
    }
  }

  if ("model" in patch) {
    const raw = patch.model;
    if (raw === null) {
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolvedDefault.provider,
          model: resolvedDefault.model,
          isDefault: true,
        },
        preserveAuthProfileOverride: shouldPreserveSessionAuthProfileOverride({
          cfg,
          currentProvider: next.providerOverride ?? next.modelProvider ?? resolvedDefault.provider,
          entry: next,
          provider: resolvedDefault.provider,
        }),
      });
      delete next.liveModelSwitchPending;
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid model: empty");
      }
      if (!params.loadGatewayModelCatalog) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable"),
        };
      }
      const catalog = await loadModelCatalogForPatch();
      if (!catalog) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable"),
        };
      }
      const { model: modelWithoutProfile, profile: trailingProfile } =
        splitTrailingAuthProfile(trimmed);
      const resolved = resolveAllowedModelRef({
        cfg,
        catalog,
        raw: modelWithoutProfile,
        defaultProvider: resolvedDefault.provider,
        defaultModel: subagentModelHint ?? resolvedDefault.model,
      });
      if ("error" in resolved) {
        return invalid(resolved.error);
      }
      const isDefault =
        resolved.ref.provider === resolvedDefault.provider &&
        resolved.ref.model === resolvedDefault.model;
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolved.ref.provider,
          model: resolved.ref.model,
          isDefault,
        },
        profileOverride: trailingProfile || undefined,
        preserveAuthProfileOverride: shouldPreserveSessionAuthProfileOverride({
          cfg,
          currentProvider: next.providerOverride ?? next.modelProvider ?? resolvedDefault.provider,
          entry: next,
          provider: resolved.ref.provider,
        }),
        markLiveSwitchPending: true,
      });
    }
  }

  if (next.thinkingLevel && ("thinkingLevel" in patch || "model" in patch)) {
    const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
    const effectiveModel = next.modelOverride ?? resolvedDefault.model;
    const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
    const thinkingCatalog = await loadModelCatalogForPatch();
    if (!thinkingLevel) {
      delete next.thinkingLevel;
    } else {
      const thinkingRuntime = resolveThinkingRuntime(effectiveProvider, effectiveModel, next);
      if (
        !isThinkingLevelSupported({
          provider: effectiveProvider,
          model: effectiveModel,
          level: thinkingLevel,
          catalog: thinkingCatalog,
          agentRuntime: thinkingRuntime,
        })
      ) {
        if ("thinkingLevel" in patch) {
          return invalid(
            `thinkingLevel "${thinkingLevel}" is not supported for ${effectiveProvider}/${effectiveModel} (use ${formatThinkingLevels(effectiveProvider, effectiveModel, "|", thinkingCatalog, thinkingRuntime)})`,
          );
        }
        next.thinkingLevel = resolveSupportedThinkingLevel({
          provider: effectiveProvider,
          model: effectiveModel,
          level: thinkingLevel,
          catalog: thinkingCatalog,
          agentRuntime: thinkingRuntime,
        });
      }
    }
  }

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(raw);
      if (!normalized) {
        return invalid('invalid sendPolicy (use "allow"|"deny")');
      }
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(raw);
      if (!normalized) {
        return invalid('invalid groupActivation (use "mention"|"always")');
      }
      next.groupActivation = normalized;
    }
  }

  return { ok: true, entry: next };
}

/** Apply a validated gateway session patch to an in-memory session store entry. */
export async function applySessionsPatchToStore(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  storeKey: string;
  agentId?: string;
  patch: SessionsPatchParams;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const projected = await projectSessionsPatchEntry({
    cfg: params.cfg,
    entries: Object.entries(params.store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    existingEntry: params.store[params.storeKey],
    storeKey: params.storeKey,
    agentId: params.agentId,
    patch: params.patch,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
  });
  if (projected.ok) {
    params.store[params.storeKey] = projected.entry;
  }
  return projected;
}
