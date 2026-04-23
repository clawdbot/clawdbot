import { sanitizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { normalizeLegacyDeliveryInput } from "./legacy-delivery.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { migrateLegacyCronPayload } from "./payload-migration.js";
import { inferLegacyName } from "./service/normalize.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "./stagger.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";

type UnknownRecord = Record<string, unknown>;

type NormalizeOptions = {
  applyDefaults?: boolean;
  /** Session context for resolving "current" sessionTarget or auto-binding when not specified */
  sessionContext?: { sessionKey?: string };
};

const DEFAULT_OPTIONS: NormalizeOptions = {
  applyDefaults: false,
};

function coerceSchedule(schedule: UnknownRecord) {
  const next: UnknownRecord = { ...schedule };
  const rawKind = typeof schedule.kind === "string" ? schedule.kind.trim().toLowerCase() : "";
  const kind = rawKind === "at" || rawKind === "every" || rawKind === "cron" ? rawKind : undefined;
  const exprRaw = typeof schedule.expr === "string" ? schedule.expr.trim() : "";
  const legacyCronRaw = typeof schedule.cron === "string" ? schedule.cron.trim() : "";
  const normalizedExpr = exprRaw || legacyCronRaw;
  const atMsRaw = schedule.atMs;
  const atRaw = schedule.at;
  const atString = typeof atRaw === "string" ? atRaw.trim() : "";
  const parsedAtMs =
    typeof atMsRaw === "number"
      ? atMsRaw
      : typeof atMsRaw === "string"
        ? parseAbsoluteTimeMs(atMsRaw)
        : atString
          ? parseAbsoluteTimeMs(atString)
          : null;

  if (kind) {
    next.kind = kind;
  } else {
    if (
      typeof schedule.atMs === "number" ||
      typeof schedule.at === "string" ||
      typeof schedule.atMs === "string"
    ) {
      next.kind = "at";
    } else if (typeof schedule.everyMs === "number") {
      next.kind = "every";
    } else if (normalizedExpr) {
      next.kind = "cron";
    }
  }

  if (atString) {
    next.at = parsedAtMs !== null ? new Date(parsedAtMs).toISOString() : atString;
  } else if (parsedAtMs !== null) {
    next.at = new Date(parsedAtMs).toISOString();
  }
  if ("atMs" in next) {
    delete next.atMs;
  }

  if (normalizedExpr) {
    next.expr = normalizedExpr;
  } else if ("expr" in next) {
    delete next.expr;
  }
  if ("cron" in next) {
    delete next.cron;
  }

  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  if (staggerMs !== undefined) {
    next.staggerMs = staggerMs;
  } else if ("staggerMs" in next) {
    delete next.staggerMs;
  }

  return next;
}

function coercePayload(payload: UnknownRecord) {
  const next: UnknownRecord = { ...payload };
  // Back-compat: older configs used `provider` for delivery channel.
  migrateLegacyCronPayload(next);
  const kindRaw = typeof next.kind === "string" ? next.kind.trim().toLowerCase() : "";
  if (kindRaw === "agentturn") {
    next.kind = "agentTurn";
  } else if (kindRaw === "systemevent") {
    next.kind = "systemEvent";
  } else if (kindRaw) {
    next.kind = kindRaw;
  }
  if (!next.kind) {
    const hasMessage = typeof next.message === "string" && next.message.trim().length > 0;
    const hasText = typeof next.text === "string" && next.text.trim().length > 0;
    const hasAgentTurnHint =
      typeof next.model === "string" ||
      typeof next.thinking === "string" ||
      typeof next.timeoutSeconds === "number" ||
      typeof next.allowUnsafeExternalContent === "boolean";
    if (hasMessage) {
      next.kind = "agentTurn";
    } else if (hasText) {
      next.kind = "systemEvent";
    } else if (hasAgentTurnHint) {
      // Accept partial agentTurn payload patches that only tweak agent-turn-only fields.
      next.kind = "agentTurn";
    }
  }
  if (typeof next.message === "string") {
    const trimmed = next.message.trim();
    if (trimmed) {
      next.message = trimmed;
    }
  }
  if (typeof next.text === "string") {
    const trimmed = next.text.trim();
    if (trimmed) {
      next.text = trimmed;
    }
  }
  if ("model" in next) {
    if (typeof next.model === "string") {
      const trimmed = next.model.trim();
      if (trimmed) {
        next.model = trimmed;
      } else {
        delete next.model;
      }
    } else {
      delete next.model;
    }
  }
  if ("thinking" in next) {
    if (typeof next.thinking === "string") {
      const trimmed = next.thinking.trim();
      if (trimmed) {
        next.thinking = trimmed;
      } else {
        delete next.thinking;
      }
    } else {
      delete next.thinking;
    }
  }
  if ("timeoutSeconds" in next) {
    if (typeof next.timeoutSeconds === "number" && Number.isFinite(next.timeoutSeconds)) {
      next.timeoutSeconds = Math.max(0, Math.floor(next.timeoutSeconds));
    } else {
      delete next.timeoutSeconds;
    }
  }
  if (
    "allowUnsafeExternalContent" in next &&
    typeof next.allowUnsafeExternalContent !== "boolean"
  ) {
    delete next.allowUnsafeExternalContent;
  }
  return next;
}

function coerceDelivery(delivery: UnknownRecord) {
  const next: UnknownRecord = { ...delivery };
  if (typeof delivery.mode === "string") {
    const mode = delivery.mode.trim().toLowerCase();
    if (mode === "deliver") {
      next.mode = "announce";
    } else if (mode === "announce" || mode === "none" || mode === "webhook") {
      next.mode = mode;
    } else {
      delete next.mode;
    }
  } else if ("mode" in next) {
    delete next.mode;
  }
  if (typeof delivery.channel === "string") {
    const trimmed = delivery.channel.trim().toLowerCase();
    if (trimmed) {
      next.channel = trimmed;
    } else {
      delete next.channel;
    }
  }
  if (typeof delivery.to === "string") {
    const trimmed = delivery.to.trim();
    if (trimmed) {
      next.to = trimmed;
    } else {
      delete next.to;
    }
  }
  if (typeof delivery.accountId === "string") {
    const trimmed = delivery.accountId.trim();
    if (trimmed) {
      next.accountId = trimmed;
    } else {
      delete next.accountId;
    }
  } else if ("accountId" in next && typeof next.accountId !== "string") {
    delete next.accountId;
  }
  return next;
}

function unwrapJob(raw: UnknownRecord) {
  if (isRecord(raw.data)) {
    return raw.data;
  }
  if (isRecord(raw.job)) {
    return raw.job;
  }
  return raw;
}

function normalizeSessionTarget(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "main" || lower === "isolated" || lower === "current") {
    return lower;
  }
  // Support custom session IDs with "session:" prefix
  if (lower.startsWith("session:")) {
    const sessionId = trimmed.slice(8).trim();
    if (sessionId) {
      return `session:${sessionId}`;
    }
  }
  return undefined;
}

function normalizeWakeMode(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "now" || trimmed === "next-heartbeat") {
    return trimmed;
  }
  return undefined;
}

function copyTopLevelAgentTurnFields(next: UnknownRecord, payload: UnknownRecord) {
  const copyString = (field: "model" | "thinking") => {
    if (typeof payload[field] === "string" && payload[field].trim()) {
      return;
    }
    const value = next[field];
    if (typeof value === "string" && value.trim()) {
      payload[field] = value.trim();
    }
  };
  copyString("model");
  copyString("thinking");

  if (typeof payload.timeoutSeconds !== "number" && typeof next.timeoutSeconds === "number") {
    payload.timeoutSeconds = next.timeoutSeconds;
  }
  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof next.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = next.allowUnsafeExternalContent;
  }
}

function copyTopLevelLegacyDeliveryFields(next: UnknownRecord, payload: UnknownRecord) {
  if (typeof payload.deliver !== "boolean" && typeof next.deliver === "boolean") {
    payload.deliver = next.deliver;
  }
  if (
    typeof payload.channel !== "string" &&
    typeof next.channel === "string" &&
    next.channel.trim()
  ) {
    payload.channel = next.channel.trim();
  }
  if (typeof payload.to !== "string" && typeof next.to === "string" && next.to.trim()) {
    payload.to = next.to.trim();
  }
  if (
    typeof payload.bestEffortDeliver !== "boolean" &&
    typeof next.bestEffortDeliver === "boolean"
  ) {
    payload.bestEffortDeliver = next.bestEffortDeliver;
  }
  if (
    typeof payload.provider !== "string" &&
    typeof next.provider === "string" &&
    next.provider.trim()
  ) {
    payload.provider = next.provider.trim();
  }
}

function stripLegacyTopLevelFields(next: UnknownRecord) {
  delete next.model;
  delete next.thinking;
  delete next.timeoutSeconds;
  delete next.allowUnsafeExternalContent;
  delete next.message;
  delete next.text;
  delete next.deliver;
  delete next.channel;
  delete next.to;
  delete next.bestEffortDeliver;
  delete next.provider;
}

export function normalizeCronJobInput(
  raw: unknown,
  options: NormalizeOptions = DEFAULT_OPTIONS,
): UnknownRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const base = unwrapJob(raw);
  const next: UnknownRecord = { ...base };

  if ("agentId" in base) {
    const agentId = base.agentId;
    if (agentId === null) {
      next.agentId = null;
    } else if (typeof agentId === "string") {
      const trimmed = agentId.trim();
      if (trimmed) {
        next.agentId = sanitizeAgentId(trimmed);
      } else {
        delete next.agentId;
      }
    }
  }

  if ("sessionKey" in base) {
    const sessionKey = base.sessionKey;
    if (sessionKey === null) {
      next.sessionKey = null;
    } else if (typeof sessionKey === "string") {
      const trimmed = sessionKey.trim();
      if (trimmed) {
        next.sessionKey = trimmed;
      } else {
        delete next.sessionKey;
      }
    }
  }

  if ("missionId" in base) {
    const missionId = base.missionId;
    if (missionId === null) {
      next.missionId = null;
    } else if (typeof missionId === "string") {
      const trimmed = missionId.trim();
      if (trimmed) {
        next.missionId = trimmed;
      } else {
        delete next.missionId;
      }
    }
  }

  if ("enabled" in base) {
    const enabled = base.enabled;
    if (typeof enabled === "boolean") {
      next.enabled = enabled;
    } else if (typeof enabled === "string") {
      const trimmed = enabled.trim().toLowerCase();
      if (trimmed === "true") {
        next.enabled = true;
      }
      if (trimmed === "false") {
        next.enabled = false;
      }
    }
  }

  if ("sessionTarget" in base) {
    const normalized = normalizeSessionTarget(base.sessionTarget);
    if (normalized) {
      next.sessionTarget = normalized;
    } else {
      delete next.sessionTarget;
    }
  }

  if ("wakeMode" in base) {
    const normalized = normalizeWakeMode(base.wakeMode);
    if (normalized) {
      next.wakeMode = normalized;
    } else {
      delete next.wakeMode;
    }
  }

  if (isRecord(base.schedule)) {
    next.schedule = coerceSchedule(base.schedule);
  }

  if (!("payload" in next) || !isRecord(next.payload)) {
    const message = typeof next.message === "string" ? next.message.trim() : "";
    const text = typeof next.text === "string" ? next.text.trim() : "";
    if (message) {
      next.payload = { kind: "agentTurn", message };
    } else if (text) {
      next.payload = { kind: "systemEvent", text };
    }
  }

  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  if (isRecord(base.delivery)) {
    next.delivery = coerceDelivery(base.delivery);
  }

  if ("isolation" in next) {
    delete next.isolation;
  }

  const payload = isRecord(next.payload) ? next.payload : null;
  if (payload && payload.kind === "agentTurn") {
    copyTopLevelAgentTurnFields(next, payload);
    copyTopLevelLegacyDeliveryFields(next, payload);
  }
  stripLegacyTopLevelFields(next);

  if (options.applyDefaults) {
    if (!next.wakeMode) {
      next.wakeMode = "now";
    }
    if (typeof next.enabled !== "boolean") {
      next.enabled = true;
    }
    if (
      (typeof next.name !== "string" || !next.name.trim()) &&
      isRecord(next.schedule) &&
      isRecord(next.payload)
    ) {
      next.name = inferLegacyName({
        schedule: next.schedule as { kind?: unknown; everyMs?: unknown; expr?: unknown },
        payload: next.payload as { kind?: unknown; text?: unknown; message?: unknown },
      });
    } else if (typeof next.name === "string") {
      const trimmed = next.name.trim();
      if (trimmed) {
        next.name = trimmed;
      }
    }
    if (!next.sessionTarget && isRecord(next.payload)) {
      const kind = typeof next.payload.kind === "string" ? next.payload.kind : "";
      // Keep default behavior unchanged for backward compatibility:
      // - systemEvent defaults to "main"
      // - agentTurn defaults to "isolated" (NOT "current", to avoid token accumulation)
      // Users must explicitly specify "current" or "session:xxx" for custom session binding
      if (kind === "systemEvent") {
        next.sessionTarget = "main";
      } else if (kind === "agentTurn") {
        next.sessionTarget = "isolated";
      }
    }

    // Resolve "current" sessionTarget to the actual sessionKey from context
    if (next.sessionTarget === "current") {
      if (options.sessionContext?.sessionKey) {
        const sessionKey = options.sessionContext.sessionKey.trim();
        if (sessionKey) {
          // Store as session:customId format for persistence
          next.sessionTarget = `session:${sessionKey}`;
        }
      }
      // If "current" wasn't resolved, fall back to "isolated" behavior
      // This handles CLI/headless usage where no session context exists
      if (next.sessionTarget === "current") {
        next.sessionTarget = "isolated";
      }
    }
    if (next.sessionTarget === "current") {
      const sessionKey = options.sessionContext?.sessionKey?.trim();
      if (sessionKey) {
        next.sessionTarget = `session:${sessionKey}`;
      } else {
        next.sessionTarget = "isolated";
      }
    }
    if (
      "schedule" in next &&
      isRecord(next.schedule) &&
      next.schedule.kind === "at" &&
      !("deleteAfterRun" in next)
    ) {
      next.deleteAfterRun = true;
    }
    if ("schedule" in next && isRecord(next.schedule) && next.schedule.kind === "cron") {
      const schedule = next.schedule as UnknownRecord;
      const explicit = normalizeCronStaggerMs(schedule.staggerMs);
      if (explicit !== undefined) {
        schedule.staggerMs = explicit;
      } else {
        const expr = typeof schedule.expr === "string" ? schedule.expr : "";
        const defaultStaggerMs = resolveDefaultCronStaggerMs(expr);
        if (defaultStaggerMs !== undefined) {
          schedule.staggerMs = defaultStaggerMs;
        }
      }
    }
    const payload = isRecord(next.payload) ? next.payload : null;
    const payloadKind = payload && typeof payload.kind === "string" ? payload.kind : "";
    const sessionTarget = typeof next.sessionTarget === "string" ? next.sessionTarget : "";
    // Support "isolated", custom session IDs (session:xxx), and resolved "current" as isolated-like targets
    const isIsolatedAgentTurn =
      sessionTarget === "isolated" ||
      sessionTarget === "current" ||
      sessionTarget.startsWith("session:") ||
      (sessionTarget === "" && payloadKind === "agentTurn");
    const hasDelivery = "delivery" in next && next.delivery !== undefined;
    const normalizedLegacy = normalizeLegacyDeliveryInput({
      delivery: isRecord(next.delivery) ? next.delivery : null,
      payload,
    });
    if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
      next.delivery = normalizedLegacy.delivery;
    }
    if (
      !hasDelivery &&
      !normalizedLegacy.delivery &&
      isIsolatedAgentTurn &&
      payloadKind === "agentTurn"
    ) {
      next.delivery = { mode: "announce" };
    }
  }

  return next;
}

export function normalizeCronJobCreate(
  raw: unknown,
  options?: Omit<NormalizeOptions, "applyDefaults">,
): CronJobCreate | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: true,
    ...options,
  }) as CronJobCreate | null;
}

export function normalizeCronJobPatch(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobPatch | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: false,
    ...options,
  }) as CronJobPatch | null;
}
