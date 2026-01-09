import { randomUUID } from "node:crypto";

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
} from "../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "./protocol/index.js";

function invalid(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message) };
}

export async function applySessionsPatchToStore(params: {
  cfg: ClawdbotConfig;
  store: Record<string, SessionEntry>;
  storeKey: string;
  patch: SessionsPatchParams;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<
  { ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }
> {
  const { cfg, store, storeKey, patch } = params;
  const now = Date.now();

  const existing = store[storeKey];
  const next: SessionEntry = existing
    ? {
        ...existing,
        updatedAt: Math.max(existing.updatedAt ?? 0, now),
      }
    : { sessionId: randomUUID(), updatedAt: now };

  if ("spawnedBy" in patch) {
    const raw = patch.spawnedBy;
    if (raw === null) {
      if (existing?.spawnedBy)
        return invalid("spawnedBy cannot be cleared once set");
    } else if (raw !== undefined) {
      const trimmed = String(raw).trim();
      if (!trimmed) return invalid("invalid spawnedBy: empty");
      if (!isSubagentSessionKey(storeKey)) {
        return invalid("spawnedBy is only supported for subagent:* sessions");
      }
      if (existing?.spawnedBy && existing.spawnedBy !== trimmed) {
        return invalid("spawnedBy cannot be changed once set");
      }
      next.spawnedBy = trimmed;
    }
  }

  if ("label" in patch) {
    const raw = patch.label;
    if (raw === null) {
      delete next.label;
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) return invalid(parsed.error);
      for (const [key, entry] of Object.entries(store)) {
        if (key === storeKey) continue;
        if (entry?.label === parsed.label) {
          return invalid(`label already in use: ${parsed.label}`);
        }
      }
      next.label = parsed.label;
    }
  }

  if ("thinkingLevel" in patch) {
    const raw = patch.thinkingLevel;
    if (raw === null) {
      delete next.thinkingLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeThinkLevel(String(raw));
      if (!normalized) {
        return invalid(
          "invalid thinkingLevel (use off|minimal|low|medium|high)",
        );
      }
      if (normalized === "off") delete next.thinkingLevel;
      else next.thinkingLevel = normalized;
    }
  }

  if ("verboseLevel" in patch) {
    const raw = patch.verboseLevel;
    if (raw === null) {
      delete next.verboseLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeVerboseLevel(String(raw));
      if (!normalized) return invalid('invalid verboseLevel (use "on"|"off")');
      if (normalized === "off") delete next.verboseLevel;
      else next.verboseLevel = normalized;
    }
  }

  if ("reasoningLevel" in patch) {
    const raw = patch.reasoningLevel;
    if (raw === null) {
      delete next.reasoningLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeReasoningLevel(String(raw));
      if (!normalized) {
        return invalid('invalid reasoningLevel (use "on"|"off"|"stream")');
      }
      if (normalized === "off") delete next.reasoningLevel;
      else next.reasoningLevel = normalized;
    }
  }

  if ("responseUsage" in patch) {
    const raw = patch.responseUsage;
    if (raw === null) {
      delete next.responseUsage;
    } else if (raw !== undefined) {
      const normalized = normalizeUsageDisplay(String(raw));
      if (!normalized) return invalid('invalid responseUsage (use "on"|"off")');
      if (normalized === "off") delete next.responseUsage;
      else next.responseUsage = normalized;
    }
  }

  if ("elevatedLevel" in patch) {
    const raw = patch.elevatedLevel;
    if (raw === null) {
      delete next.elevatedLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeElevatedLevel(String(raw));
      if (!normalized) return invalid('invalid elevatedLevel (use "on"|"off")');
      if (normalized === "off") delete next.elevatedLevel;
      else next.elevatedLevel = normalized;
    }
  }

  if ("model" in patch) {
    const raw = patch.model;
    if (raw === null) {
      delete next.providerOverride;
      delete next.modelOverride;
    } else if (raw !== undefined) {
      const trimmed = String(raw).trim();
      if (!trimmed) return invalid("invalid model: empty");

      const resolvedDefault = resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const aliasIndex = buildModelAliasIndex({
        cfg,
        defaultProvider: resolvedDefault.provider,
      });
      const resolved = resolveModelRefFromString({
        raw: trimmed,
        defaultProvider: resolvedDefault.provider,
        aliasIndex,
      });
      if (!resolved) return invalid(`invalid model: ${trimmed}`);

      if (!params.loadGatewayModelCatalog) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            "model catalog unavailable",
          ),
        };
      }
      const catalog = await params.loadGatewayModelCatalog();
      const allowed = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      const key = modelKey(resolved.ref.provider, resolved.ref.model);
      if (!allowed.allowAny && !allowed.allowedKeys.has(key)) {
        return invalid(`model not allowed: ${key}`);
      }
      if (
        resolved.ref.provider === resolvedDefault.provider &&
        resolved.ref.model === resolvedDefault.model
      ) {
        delete next.providerOverride;
        delete next.modelOverride;
      } else {
        next.providerOverride = resolved.ref.provider;
        next.modelOverride = resolved.ref.model;
      }
    }
  }

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(String(raw));
      if (!normalized)
        return invalid('invalid sendPolicy (use "allow"|"deny")');
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(String(raw));
      if (!normalized) {
        return invalid('invalid groupActivation (use "mention"|"always")');
      }
      next.groupActivation = normalized;
    }
  }

  store[storeKey] = next;
  return { ok: true, entry: next };
}
