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
  normalizeSessionIconInput,
  type SessionCreatedActor,
  type SessionsPatchParams,
} from "../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
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
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  isAgentHarnessSessionKeyOwnedBy,
  resolveMissingAgentHarnessSessionError,
} from "../sessions/agent-harness-session-key.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../sessions/model-overrides.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import {
  isSessionAgentAttentionIconId,
  resolveActiveSessionAgentStatus,
  sanitizeSessionAgentStatusNote,
  sessionAgentStatusExpiresAt,
  SESSION_AGENT_STATUS_MAX_TTL_MINUTES,
} from "../sessions/session-agent-status.js";
import { parseSessionLabel, SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";
import {
  isAgentSessionModelPatchOrigin,
  shouldPreserveSessionAuthProfileOverride,
  snapshotAgentModelFallback,
} from "./session-model-patch-origin.js";
import { applySessionsPatchSubagentPolicy } from "./sessions-patch-subagent-policy.js";

function invalid(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message) };
}

export function resolveSessionPatchModelSelection(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  subagentModelHint?: string;
}):
  | { ok: true; provider: string; model: string; profile?: string; isDefault: boolean }
  | { ok: false; error: string } {
  const { model: modelWithoutProfile, profile } = splitTrailingAuthProfile(params.raw);
  const resolved = resolveAllowedModelRef({
    cfg: params.cfg,
    catalog: params.catalog,
    raw: modelWithoutProfile,
    defaultProvider: params.defaultProvider,
    defaultModel: params.subagentModelHint ?? params.defaultModel,
  });
  if ("error" in resolved) {
    return { ok: false, error: resolved.error };
  }
  return {
    ok: true,
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    ...(profile ? { profile } : {}),
    isDefault:
      resolved.ref.provider === params.defaultProvider &&
      resolved.ref.model === params.defaultModel,
  };
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
  archivedBy?: SessionCreatedActor;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  /** Exact harness owner authorized to project its new reserved session row. */
  authorizedAgentHarnessId?: string;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const { cfg, storeKey, patch } = params;
  const authorizedHarnessCreation =
    params.existingEntry === undefined &&
    isAgentHarnessSessionKeyOwnedBy(storeKey, params.authorizedAgentHarnessId);
  const harnessSessionError = authorizedHarnessCreation
    ? undefined
    : resolveMissingAgentHarnessSessionError(storeKey, params.existingEntry);
  if (harnessSessionError) {
    return invalid(harnessSessionError);
  }
  if ("model" in patch && isModelSelectionLocked(params.existingEntry)) {
    return invalid(MODEL_SELECTION_LOCKED_MESSAGE);
  }
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
  const loadPreparedModelCatalogForPatch = async () => {
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

  const subagentPolicyError = applySessionsPatchSubagentPolicy({
    existing,
    next,
    patch,
    storeKey,
  });
  if (subagentPolicyError) {
    return invalid(subagentPolicyError);
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

  if ("icon" in patch) {
    const raw = patch.icon;
    if (raw === null) {
      delete next.icon;
    } else if (raw !== undefined) {
      const normalized = normalizeSessionIconInput(raw);
      if (!normalized.ok) {
        return invalid(`invalid icon: ${normalized.reason}`);
      }
      next.icon = normalized.value;
    }
  }

  if ("statusNote" in patch || "attention" in patch || "ttlMinutes" in patch) {
    const rawNote = patch.statusNote;
    const rawAttention = patch.attention;
    const ttlMinutes = patch.ttlMinutes;
    if (
      ttlMinutes !== undefined &&
      (!Number.isInteger(ttlMinutes) ||
        ttlMinutes < 1 ||
        ttlMinutes > SESSION_AGENT_STATUS_MAX_TTL_MINUTES)
    ) {
      return invalid(`invalid ttlMinutes (use 1-${SESSION_AGENT_STATUS_MAX_TTL_MINUTES})`);
    }
    if (rawNote === null || rawAttention === null) {
      if (
        (rawNote !== undefined && rawNote !== null) ||
        (rawAttention !== undefined && rawAttention !== null)
      ) {
        return invalid("cannot clear and set agent status in the same patch");
      }
      delete next.agentStatus;
    } else {
      const current = resolveActiveSessionAgentStatus(next.agentStatus, now);
      const note = rawNote === undefined ? current?.note : sanitizeSessionAgentStatusNote(rawNote);
      if (!note) {
        return invalid("statusNote required before setting attention or ttlMinutes");
      }
      if (rawAttention !== undefined && !isSessionAgentAttentionIconId(rawAttention)) {
        return invalid("invalid attention icon");
      }
      const attention = rawAttention ?? current?.attention;
      next.agentStatus = {
        note,
        expiresAt: sessionAgentStatusExpiresAt(now, ttlMinutes),
        ...(attention ? { attention } : {}),
      };
    }
  }

  if ("archived" in patch) {
    if (patch.archived === true) {
      // Archived sessions leave the active quick-access set in the same write.
      if (next.archivedAt === undefined) {
        next.archivedAt = now;
        if (params.archivedBy) {
          next.archivedBy = params.archivedBy;
        } else {
          delete next.archivedBy;
        }
      }
      delete next.pinnedAt;
    } else {
      delete next.archivedAt;
      delete next.archivedBy;
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
      delete next.agentStatus;
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
        const thinkingCatalog = await loadPreparedModelCatalogForPatch();
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
      delete next.execCwd;
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid execNode: empty");
      }
      if (trimmed !== next.execNode) {
        // A cwd belongs to one node's filesystem; never carry it across node bindings.
        delete next.execCwd;
      }
      next.execNode = trimmed;
    }
  }
  if ("model" in patch) {
    const agentModelFallback = isAgentSessionModelPatchOrigin()
      ? next.modelFallback?.source === "agent-patch"
        ? { ...next.modelFallback, ts: Math.max(now, next.modelFallback.ts + 1) }
        : snapshotAgentModelFallback(cfg, next, sessionAgentId, now)
      : undefined;
    delete next.modelFallback;
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
      const catalog = await loadPreparedModelCatalogForPatch();
      if (!catalog) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable"),
        };
      }
      const resolved = resolveSessionPatchModelSelection({
        cfg,
        catalog,
        raw: trimmed,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
        subagentModelHint,
      });
      if (!resolved.ok) {
        return invalid(resolved.error);
      }
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolved.provider,
          model: resolved.model,
          isDefault: resolved.isDefault,
        },
        profileOverride: resolved.profile,
        preserveAuthProfileOverride: shouldPreserveSessionAuthProfileOverride({
          cfg,
          currentProvider: next.providerOverride ?? next.modelProvider ?? resolvedDefault.provider,
          entry: next,
          provider: resolved.provider,
        }),
        markLiveSwitchPending: true,
      });
    }
    if (agentModelFallback) {
      next.modelFallback = agentModelFallback;
    }
  }

  if (next.thinkingLevel && ("thinkingLevel" in patch || "model" in patch)) {
    const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
    const effectiveModel = next.modelOverride ?? resolvedDefault.model;
    const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
    const thinkingCatalog = await loadPreparedModelCatalogForPatch();
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

  // A thinkingLevel change made on its own (no model switch) never touches the
  // agent-patch revert marker, so realign its restore target with the user's
  // newer choice; otherwise a later model-failure revert clobbers it.
  if (
    "thinkingLevel" in patch &&
    !("model" in patch) &&
    next.modelFallback?.source === "agent-patch"
  ) {
    next.modelFallback = next.thinkingLevel
      ? { ...next.modelFallback, prevThinkingLevel: next.thinkingLevel }
      : { ...next.modelFallback, prevThinkingLevel: undefined };
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
  archivedBy?: SessionCreatedActor;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  /** Exact harness owner authorized to project its new reserved session row. */
  authorizedAgentHarnessId?: string;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const projected = await projectSessionsPatchEntry({
    cfg: params.cfg,
    entries: Object.entries(params.store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    existingEntry: params.store[params.storeKey],
    storeKey: params.storeKey,
    agentId: params.agentId,
    patch: params.patch,
    archivedBy: params.archivedBy,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
    authorizedAgentHarnessId: params.authorizedAgentHarnessId,
  });
  if (projected.ok) {
    params.store[params.storeKey] = projected.entry;
  }
  return projected;
}
