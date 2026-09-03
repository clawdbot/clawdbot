// Session patch applier for gateway session metadata and model/runtime overrides.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  requiresAgentHarnessPluginSelection,
  resolveAgentHarnessOwnerPluginIds,
} from "../agents/harness/runtime-plugin-load-plan.js";
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
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import {
  buildSessionCreationStamp,
  type SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import { projectCanonicalSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeExecTarget } from "../infra/exec-approvals.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  isAgentHarnessSessionKeyOwnedBy,
  resolveMissingAgentHarnessSessionError,
} from "../sessions/agent-harness-session-key.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../sessions/auth-profile-preservation.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import {
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
import {
  isAgentSessionModelPatchOrigin,
  snapshotAgentModelFallback,
} from "./session-model-patch-origin.js";
import { normalizeSessionToolOverrides } from "./session-tool-overrides.js";
import { applySessionContextWindowPatch } from "./sessions-patch-context-window.js";
import { applySessionsPatchDisplayMetadata } from "./sessions-patch-display-metadata.js";
import { applySessionsPatchSubagentPolicy } from "./sessions-patch-subagent-policy.js";

function invalid(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message) };
}

export function resolveSessionPatchModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
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
    agentId: params.agentId,
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

/** Project a validated gateway session patch for one session entry. */
export async function projectSessionsPatchEntry(params: {
  cfg: OpenClawConfig;
  creation?: { via: SessionCreatedVia; actor?: SessionEntry["createdActor"] };
  existingEntry?: SessionEntry;
  isLabelInUse: (label: string) => boolean;
  storeKey: string;
  agentId?: string;
  patch: SessionsPatchParams;
  /** Canonical root prepared by the trusted create path; never accepted from public patches. */
  preparedSessionRoot?: string;
  /** Trusted catalog runtime must own selection checks before the new row is persisted. */
  preparedAgentRuntime?: string;
  archivedBy?: SessionEntry["archivedBy"];
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  providerAuthMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  /** Exact harness owner authorized to project its new reserved session row. */
  authorizedAgentHarnessId?: string;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const { cfg, storeKey, patch, creation } = params;
  if ("execSecurity" in patch || "execAsk" in patch) {
    return invalid(
      "execSecurity/execAsk are retired; set permissionMode (read-only|guarded|workspace|full) instead, or use /exec for this run only.",
    );
  }
  const authorizedHarnessCreation =
    params.existingEntry === undefined &&
    isAgentHarnessSessionKeyOwnedBy(storeKey, params.authorizedAgentHarnessId);
  const harnessSessionError = authorizedHarnessCreation
    ? undefined
    : resolveMissingAgentHarnessSessionError(storeKey, params.existingEntry);
  if (harnessSessionError) {
    return invalid(harnessSessionError);
  }
  if (typeof patch.archived === "boolean") {
    if (!params.existingEntry?.sessionId) {
      return invalid(`session not found: ${storeKey}`);
    }
    if (patch.expectedSessionId === undefined) {
      return invalid(`expectedSessionId required for session lifecycle patch: ${storeKey}`);
    }
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
    const acpMeta = readAcpSessionMetaForEntry({
      sessionKey: storeKey,
      agentId: sessionAgentId,
      entry,
    });
    return (
      params.preparedAgentRuntime ??
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
    if (!loadedModelCatalog && params.loadGatewayModelCatalog) {
      const catalog = await params.loadGatewayModelCatalog();
      loadedModelCatalog = Array.isArray(catalog) ? catalog : [];
    }
    return loadedModelCatalog;
  };

  const existing =
    params.existingEntry && projectCanonicalSessionEntryShape({ ...params.existingEntry });
  // Existing entries without session ids are placeholder aliases; assigning an id makes them real.
  const next: SessionEntry = {
    ...existing,
    sessionId: existing?.sessionId || randomUUID(),
    updatedAt: Math.max(existing?.updatedAt ?? 0, now),
    ...(params.preparedSessionRoot ? { sessionRoot: params.preparedSessionRoot } : {}),
    // Stamp only genuinely new rows; existing placeholder aliases must not be restamped.
    ...(creation && params.existingEntry === undefined ? buildSessionCreationStamp(creation) : {}),
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

  const displayMetadataError = applySessionsPatchDisplayMetadata({
    patch,
    next,
    isLabelInUse: params.isLabelInUse,
  });
  if (displayMetadataError) {
    return invalid(displayMetadataError);
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
        next.archiveReason = "manual";
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
      delete next.archiveReason;
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
      // This timestamp is also the conditional-ack revision. Repeated writes in
      // one clock tick must still represent distinct manual unread intent.
      next.markedUnreadAt = Math.max(now, (params.existingEntry?.markedUnreadAt ?? 0) + 1);
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

  if ("toolOverrides" in patch) {
    const raw = patch.toolOverrides;
    if (raw === null) {
      delete next.toolOverrides;
    } else if (raw !== undefined) {
      // Session patches replace this sparse overlay atomically; they never deep-merge old policy.
      const normalized = normalizeSessionToolOverrides(raw);
      if (normalized) {
        next.toolOverrides = normalized;
      } else {
        delete next.toolOverrides;
      }
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

  if ("execNode" in patch) {
    if (patch.execNode === null) {
      delete next.execNode;
      delete next.execCwd;
      if (next.execHost === "node") {
        delete next.execHost;
      }
    } else if (patch.execNode !== undefined) {
      const trimmed = normalizeOptionalString(patch.execNode) ?? "";
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
  if ("permissionMode" in patch) {
    if (patch.permissionMode === null) {
      delete next.permissionMode;
    } else if (patch.permissionMode !== undefined) {
      next.permissionMode = patch.permissionMode;
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
    let selection:
      | { provider: string; model: string; profile?: string; isDefault: boolean }
      | undefined;
    if (raw === null) {
      selection = { ...resolvedDefault, isDefault: true };
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid model: empty");
      }
      const catalog = await loadPreparedModelCatalogForPatch();
      if (!catalog) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            "model catalog is still loading; retry in a few seconds",
          ),
        };
      }
      const resolved = resolveSessionPatchModelSelection({
        cfg,
        agentId: sessionAgentId,
        catalog,
        raw: trimmed,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
        subagentModelHint,
      });
      if (!resolved.ok) {
        return invalid(resolved.error);
      }
      selection = resolved;
    }
    if (selection) {
      // Catalog membership does not guarantee an activatable harness. Reject before
      // committing the session so sticky defaults cannot retain an unusable selection.
      const harnessSelection = {
        provider: selection.provider,
        modelId: selection.model,
        runtime: resolveThinkingRuntime(selection.provider, selection.model, next),
        agentId: sessionAgentId,
      };
      if (
        !readAcpSessionMetaForEntry({
          sessionKey: storeKey,
          agentId: sessionAgentId,
          entry: next,
        }) &&
        requiresAgentHarnessPluginSelection(harnessSelection, cfg) &&
        resolveAgentHarnessOwnerPluginIds({
          ...harnessSelection,
          config: cfg,
          workspaceDir: resolveAgentWorkspaceDir(cfg, sessionAgentId),
        }).length === 0
      ) {
        return invalid(
          `Model ${selection.provider}/${selection.model} requires agent harness "${harnessSelection.runtime}", but no enabled plugin provides it. Install and enable its plugin, restart the Gateway, then select the model again.`,
        );
      }
      applyModelOverrideWithAuthProfileCompatibility({
        cfg,
        agentDir: resolveAgentDir(cfg, sessionAgentId),
        entry: next,
        currentProvider: next.providerOverride ?? next.modelProvider ?? resolvedDefault.provider,
        selection,
        profileOverride: selection.profile,
        ...(params.providerAuthMetadataSnapshot
          ? { metadataSnapshot: params.providerAuthMetadataSnapshot }
          : {}),
        markLiveSwitchPending: raw !== null,
      });
      if (raw === null) {
        delete next.liveModelSwitchPending;
      }
    }
    if (agentModelFallback) {
      next.modelFallback = agentModelFallback;
    }
  }

  if ("thinkingLevel" in patch || "model" in patch) {
    const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
    const effectiveModel = next.modelOverride ?? resolvedDefault.model;
    const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
    let thinkingRuntime: string | undefined;
    if (!thinkingLevel) {
      delete next.thinkingLevel;
    } else {
      const thinkingCatalog = await loadPreparedModelCatalogForPatch();
      thinkingRuntime = resolveThinkingRuntime(effectiveProvider, effectiveModel, next);
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

  const contextWindowPatch = await applySessionContextWindowPatch({
    defaultModel: resolvedDefault.model,
    defaultProvider: resolvedDefault.provider,
    loadModelCatalog: loadPreparedModelCatalogForPatch,
    next,
    patch,
  });
  if (!contextWindowPatch.ok) {
    return invalid(contextWindowPatch.error);
  }

  // A thinkingLevel change made on its own (no model switch) never touches the
  // agent-patch revert marker, so realign its restore target with the user's
  // newer choice; otherwise a later model-failure revert clobbers it.
  if (
    "thinkingLevel" in patch &&
    !("model" in patch) &&
    next.modelFallback?.source === "agent-patch"
  ) {
    next.modelFallback.prevThinkingLevel = next.thinkingLevel;
  }
  if (
    "contextWindow" in patch &&
    !("model" in patch) &&
    next.modelFallback?.source === "agent-patch"
  ) {
    next.modelFallback.prevContextWindow = next.contextWindow;
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

  // Fresh rows and placeholder aliases have no running model to replace. Model
  // and context-window initialization must not queue a switch on their first turn.
  if (!existing?.sessionId) {
    delete next.liveModelSwitchPending;
  }

  return { ok: true, entry: next };
}
