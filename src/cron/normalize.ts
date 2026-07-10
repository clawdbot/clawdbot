/** Normalizes cron create/patch payloads before validation and persistence. */
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { sanitizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import {
  TimeoutSecondsFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
  parseDeliveryInput,
  parseOptionalField,
} from "./delivery-field-schemas.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import { inferCronJobName } from "./service/normalize.js";
import {
  assertSafeCronSessionTargetId,
  resolveCronCurrentSessionTarget,
} from "./session-target.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "./stagger.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";

type UnknownRecord = Record<string, unknown>;

type NormalizeOptions = {
  applyDefaults?: boolean;
  /** Session context used to resolve "current" sessionTarget during create-time defaulting. */
  sessionContext?: { sessionKey?: string };
};

const DEFAULT_OPTIONS: NormalizeOptions = {
  applyDefaults: false,
};

function normalizeTrimmedStringArray(
  value: unknown,
  options?: { allowNull?: boolean },
): string[] | null | undefined {
  if (Array.isArray(value)) {
    const normalized = normalizeTrimmedStringList(value);
    if (normalized.length === 0 && value.length > 0) {
      return undefined;
    }
    return normalized;
  }
  if (options?.allowNull && value === null) {
    return null;
  }
  return undefined;
}

function normalizeTrimmedStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey);
    const val = typeof rawValue === "string" ? rawValue : undefined;
    if (!key || val === undefined) {
      return undefined;
    }
    entries.push([key, val]);
  }
  return Object.fromEntries(entries);
}

function normalizeCommandArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return undefined;
  }
  return [...value];
}

function hasAgentTurnOnlyPayloadHint(payload: UnknownRecord): boolean {
  return (
    "model" in payload ||
    "fallbacks" in payload ||
    "thinking" in payload ||
    "timeoutSeconds" in payload ||
    "toolsAllow" in payload ||
    typeof payload.lightContext === "boolean" ||
    typeof payload.allowUnsafeExternalContent === "boolean"
  );
}

function coerceSchedule(schedule: UnknownRecord) {
  const next: UnknownRecord = { ...schedule };
  const rawKind = normalizeLowercaseStringOrEmpty(schedule.kind);
  const kind =
    rawKind === "at" || rawKind === "every" || rawKind === "cron" || rawKind === "on-exit"
      ? rawKind
      : undefined;
  const exprRaw = normalizeOptionalString(schedule.expr) ?? "";
  const timezone = normalizeOptionalString(schedule.tz);
  const commandRaw = normalizeOptionalString(schedule.command) ?? "";
  const cwdRaw = normalizeOptionalString(schedule.cwd) ?? "";
  const everyMs = coerceFiniteScheduleNumber(schedule.everyMs);
  const anchorMs = coerceFiniteScheduleNumber(schedule.anchorMs);
  const atString = normalizeOptionalString(schedule.at) ?? "";
  const parsedAtMs = atString ? parseAbsoluteTimeMs(atString) : null;

  if (kind) {
    next.kind = kind;
  }

  const parsedAtIso = parsedAtMs !== null ? timestampMsToIsoString(parsedAtMs) : undefined;
  if (atString) {
    next.at = parsedAtIso ?? atString;
  } else if (parsedAtIso !== undefined) {
    next.at = parsedAtIso;
  }

  if (exprRaw) {
    next.expr = exprRaw;
  } else if ("expr" in next) {
    delete next.expr;
  }
  if (timezone) {
    next.tz = timezone;
  } else if ("tz" in next) {
    delete next.tz;
  }

  if (everyMs !== undefined && everyMs >= 1) {
    next.everyMs = Math.floor(everyMs);
  }
  if (anchorMs !== undefined && anchorMs >= 0) {
    next.anchorMs = Math.floor(anchorMs);
  }
  if (commandRaw) {
    next.command = commandRaw;
  } else if ("command" in next) {
    delete next.command;
  }
  if (cwdRaw) {
    next.cwd = cwdRaw;
  } else if ("cwd" in next) {
    delete next.cwd;
  }
  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  if (staggerMs !== undefined) {
    next.staggerMs = staggerMs;
  } else if ("staggerMs" in next) {
    delete next.staggerMs;
  }

  if (next.kind === "at") {
    // Keep each schedule variant canonical so persisted jobs do not carry stale
    // fields from a previous kind after CLI/API normalization.
    delete next.everyMs;
    delete next.anchorMs;
    delete next.expr;
    delete next.tz;
    delete next.staggerMs;
  } else if (next.kind === "every") {
    delete next.at;
    delete next.expr;
    delete next.tz;
    delete next.staggerMs;
  } else if (next.kind === "cron") {
    delete next.at;
    delete next.everyMs;
    delete next.anchorMs;
    delete next.command;
    delete next.cwd;
  } else if (next.kind === "on-exit") {
    delete next.at;
    delete next.everyMs;
    delete next.anchorMs;
    delete next.expr;
    delete next.tz;
    delete next.staggerMs;
  }

  if (next.kind !== "on-exit") {
    delete next.command;
    delete next.cwd;
  }

  return next;
}

function coercePayload(payload: UnknownRecord) {
  const next: UnknownRecord = { ...payload };
  const kindRaw = normalizeLowercaseStringOrEmpty(next.kind);
  if (kindRaw === "agentturn") {
    next.kind = "agentTurn";
  } else if (kindRaw === "systemevent") {
    next.kind = "systemEvent";
  } else if (kindRaw === "command") {
    next.kind = "command";
  } else if (kindRaw) {
    next.kind = kindRaw;
  }
  if (typeof next.message === "string") {
    const trimmed = normalizeOptionalString(next.message) ?? "";
    if (trimmed) {
      next.message = trimmed;
    } else {
      next.message = "";
    }
  }
  if (typeof next.text === "string") {
    const trimmed = normalizeOptionalString(next.text) ?? "";
    if (trimmed) {
      next.text = trimmed;
    } else {
      next.text = "";
    }
  }
  if ("model" in next) {
    if (next.model === null) {
      next.model = null;
    } else {
      const model = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.model);
      if (model !== undefined) {
        next.model = model;
      } else {
        delete next.model;
      }
    }
  }
  if ("thinking" in next) {
    // Preserve an explicit null so patches can clear a stored thinking override,
    // matching the model/fallbacks/toolsAllow clear paths.
    if (next.thinking === null) {
      next.thinking = null;
    } else {
      const thinking = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.thinking);
      if (thinking !== undefined) {
        next.thinking = thinking;
      } else {
        delete next.thinking;
      }
    }
  }
  if ("timeoutSeconds" in next) {
    const timeoutSeconds = parseOptionalField(TimeoutSecondsFieldSchema, next.timeoutSeconds);
    if (timeoutSeconds !== undefined) {
      next.timeoutSeconds = timeoutSeconds;
    } else {
      delete next.timeoutSeconds;
    }
  }
  if ("fallbacks" in next) {
    const fallbacks = normalizeTrimmedStringArray(next.fallbacks, { allowNull: true });
    if (fallbacks !== undefined) {
      next.fallbacks = fallbacks;
    } else {
      delete next.fallbacks;
    }
  }
  if ("toolsAllow" in next) {
    const toolsAllow = normalizeTrimmedStringArray(next.toolsAllow, { allowNull: true });
    if (toolsAllow !== undefined) {
      next.toolsAllow = toolsAllow;
    } else {
      delete next.toolsAllow;
    }
  }
  if ("argv" in next) {
    const argv = normalizeCommandArgv(next.argv);
    if (Array.isArray(argv) && argv.length > 0) {
      next.argv = argv;
    } else {
      delete next.argv;
    }
  }
  if ("cwd" in next) {
    const cwd = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.cwd);
    if (cwd !== undefined) {
      next.cwd = cwd;
    } else {
      delete next.cwd;
    }
  }
  if ("env" in next) {
    const env = normalizeTrimmedStringRecord(next.env);
    if (env !== undefined) {
      next.env = env;
    } else {
      delete next.env;
    }
  }
  if ("input" in next && typeof next.input !== "string") {
    delete next.input;
  }
  if ("noOutputTimeoutSeconds" in next) {
    const noOutputTimeoutSeconds = parseOptionalField(
      TimeoutSecondsFieldSchema,
      next.noOutputTimeoutSeconds,
    );
    if (noOutputTimeoutSeconds !== undefined) {
      next.noOutputTimeoutSeconds = noOutputTimeoutSeconds;
    } else {
      delete next.noOutputTimeoutSeconds;
    }
  }
  if ("outputMaxBytes" in next) {
    const outputMaxBytes = parseOptionalField(TimeoutSecondsFieldSchema, next.outputMaxBytes);
    if (outputMaxBytes !== undefined && outputMaxBytes > 0) {
      next.outputMaxBytes = Math.floor(outputMaxBytes);
    } else {
      delete next.outputMaxBytes;
    }
  }
  if (
    "allowUnsafeExternalContent" in next &&
    typeof next.allowUnsafeExternalContent !== "boolean"
  ) {
    delete next.allowUnsafeExternalContent;
  }
  if (!("kind" in next) && typeof next.text === "string" && hasAgentTurnOnlyPayloadHint(next)) {
    next.kind = "agentTurn";
    next.message = next.text;
  }
  if (next.kind === "systemEvent") {
    delete next.message;
    delete next.model;
    delete next.fallbacks;
    delete next.thinking;
    delete next.timeoutSeconds;
    delete next.lightContext;
    delete next.allowUnsafeExternalContent;
    delete next.toolsAllow;
    delete next.argv;
    delete next.cwd;
    delete next.env;
    delete next.input;
    delete next.noOutputTimeoutSeconds;
    delete next.outputMaxBytes;
  } else if (next.kind === "agentTurn") {
    delete next.text;
    delete next.argv;
    delete next.cwd;
    delete next.env;
    delete next.input;
    delete next.noOutputTimeoutSeconds;
    delete next.outputMaxBytes;
  } else if (next.kind === "command") {
    delete next.text;
    delete next.message;
    delete next.model;
    delete next.fallbacks;
    delete next.thinking;
    delete next.lightContext;
    delete next.allowUnsafeExternalContent;
    delete next.toolsAllow;
  }
  return next;
}

function coerceTrigger(trigger: UnknownRecord): UnknownRecord {
  const script = typeof trigger.script === "string" ? trigger.script.trim() : "";
  const once = parseBoolean(trigger.once);
  return {
    script,
    ...(once !== undefined ? { once } : {}),
  };
}

function coerceDelivery(delivery: UnknownRecord) {
  const next: UnknownRecord = { ...delivery };
  const parsed = parseDeliveryInput(delivery);
  if (parsed.mode !== undefined) {
    next.mode = parsed.mode;
  } else if ("mode" in next) {
    delete next.mode;
  }
  if ("channel" in delivery && delivery.channel === null) {
    next.channel = null;
  } else if (parsed.channel !== undefined) {
    next.channel = parsed.channel;
  } else if ("channel" in next) {
    delete next.channel;
  }
  if ("to" in delivery && delivery.to === null) {
    next.to = null;
  } else if (parsed.to !== undefined) {
    next.to = parsed.to;
  } else if ("to" in next) {
    delete next.to;
  }
  if ("threadId" in delivery && delivery.threadId === null) {
    next.threadId = null;
  } else if (parsed.threadId !== undefined) {
    next.threadId = parsed.threadId;
  } else if ("threadId" in next) {
    delete next.threadId;
  }
  if ("accountId" in delivery && delivery.accountId === null) {
    next.accountId = null;
  } else if (parsed.accountId !== undefined) {
    next.accountId = parsed.accountId;
  } else if ("accountId" in next) {
    delete next.accountId;
  }
  if ("failureDestination" in next) {
    // Null is an explicit clear signal in patches; invalid objects are dropped.
    if (next.failureDestination === null) {
      next.failureDestination = null;
    } else if (isRecord(next.failureDestination)) {
      next.failureDestination = coerceFailureDestination(next.failureDestination);
    } else {
      delete next.failureDestination;
    }
  }
  if ("completionDestination" in next) {
    // Completion destinations are currently webhook-only, so other shapes are
    // discarded before they can persist as ambiguous config.
    if (next.completionDestination === null) {
      next.completionDestination = null;
    } else {
      const completionDestination = isRecord(next.completionDestination)
        ? coerceCompletionDestination(next.completionDestination)
        : null;
      if (completionDestination) {
        next.completionDestination = completionDestination;
      } else {
        delete next.completionDestination;
      }
    }
  }
  return next;
}

function coerceCompletionDestination(value: UnknownRecord) {
  const mode = normalizeOptionalLowercaseString(value.mode);
  const to = normalizeOptionalString(value.to);
  if (mode !== "webhook") {
    return null;
  }
  return {
    mode,
    ...(to ? { to } : {}),
  } satisfies UnknownRecord;
}

function coerceFailureDestination(value: UnknownRecord) {
  const next: UnknownRecord = { ...value };
  if ("channel" in next) {
    if (next.channel === null) {
      next.channel = null;
    } else if (next.channel === undefined) {
      next.channel = undefined;
    } else {
      const channel = normalizeOptionalLowercaseString(next.channel);
      if (channel) {
        next.channel = channel;
      } else {
        delete next.channel;
      }
    }
  }
  if ("to" in next) {
    if (next.to === null) {
      next.to = null;
    } else if (next.to === undefined) {
      next.to = undefined;
    } else {
      const to = normalizeOptionalString(next.to);
      if (to) {
        next.to = to;
      } else {
        delete next.to;
      }
    }
  }
  if ("accountId" in next) {
    if (next.accountId === null) {
      next.accountId = null;
    } else if (next.accountId === undefined) {
      next.accountId = undefined;
    } else {
      const accountId = normalizeOptionalString(next.accountId);
      if (accountId) {
        next.accountId = accountId;
      } else {
        delete next.accountId;
      }
    }
  }
  if ("mode" in next) {
    if (next.mode === null) {
      next.mode = null;
    } else if (next.mode === undefined) {
      next.mode = undefined;
    } else {
      const mode = normalizeOptionalLowercaseString(next.mode);
      if (mode === "announce" || mode === "webhook") {
        next.mode = mode;
      } else {
        delete next.mode;
      }
    }
  }
  return next;
}

function normalizeSessionTarget(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower === "main" || lower === "isolated" || lower === "current") {
    return lower;
  }
  // Custom session targets must still pass the same session-id safety gate used
  // by runtime session resolution.
  if (lower.startsWith("session:")) {
    return `session:${assertSafeCronSessionTargetId(trimmed.slice(8))}`;
  }
  return undefined;
}

function normalizeWakeMode(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (trimmed === "now" || trimmed === "next-heartbeat") {
    return trimmed;
  }
  return undefined;
}

/** Normalizes raw cron job input without deciding whether create-time defaults apply. */
export function normalizeCronJobInput(
  raw: unknown,
  options: NormalizeOptions = DEFAULT_OPTIONS,
): UnknownRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const base = raw;
  const next: UnknownRecord = { ...base };

  for (const field of ["declarationKey", "displayName"] as const) {
    if (field in base && typeof base[field] === "string") {
      const trimmed = base[field].trim();
      if (trimmed) {
        next[field] = trimmed;
      } else {
        delete next[field];
      }
    }
  }

  if (isRecord(base.owner)) {
    const agentId = normalizeOptionalString(base.owner.agentId);
    const sessionKey = normalizeOptionalString(base.owner.sessionKey);
    if (agentId || sessionKey) {
      next.owner = {
        ...(agentId ? { agentId: sanitizeAgentId(agentId) } : {}),
        ...(sessionKey ? { sessionKey } : {}),
      };
    } else {
      delete next.owner;
    }
  }

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

  if ("enabled" in base) {
    const enabled = parseBoolean(base.enabled);
    if (enabled !== undefined) {
      next.enabled = enabled;
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

  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  if ("trigger" in base) {
    if (base.trigger === null) {
      next.trigger = null;
    } else if (isRecord(base.trigger)) {
      next.trigger = coerceTrigger(base.trigger);
    } else {
      delete next.trigger;
    }
  }

  if (isRecord(base.delivery)) {
    next.delivery = coerceDelivery(base.delivery);
  }

  if (options.applyDefaults) {
    // Defaults apply only on create; patch normalization must preserve omitted
    // fields so partial updates do not rewrite unrelated cron settings.
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
      next.name = inferCronJobName({
        schedule: next.schedule as { kind?: unknown; everyMs?: unknown; expr?: unknown },
        payload: next.payload as {
          kind?: unknown;
          text?: unknown;
          message?: unknown;
          argv?: unknown;
        },
      });
    } else if (typeof next.name === "string") {
      const trimmed = next.name.trim();
      if (trimmed) {
        next.name = trimmed;
      }
    }
    if (!next.sessionTarget && isRecord(next.payload)) {
      const kind = typeof next.payload.kind === "string" ? next.payload.kind : "";
      // Keep create-time defaults explicit: system events join main, while agent
      // turns isolate by default to avoid unbounded token accumulation.
      if (kind === "systemEvent") {
        next.sessionTarget = "main";
      } else if (kind === "agentTurn" || kind === "command") {
        next.sessionTarget = "isolated";
      }
    }

    const resolvedSessionTarget = resolveCronCurrentSessionTarget({
      sessionTarget: typeof next.sessionTarget === "string" ? next.sessionTarget : undefined,
      sessionKey: options.sessionContext?.sessionKey,
    });
    if (resolvedSessionTarget !== undefined) {
      next.sessionTarget = resolvedSessionTarget;
    } else {
      delete next.sessionTarget;
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
    // Resolved "current" and custom session ids still use isolated-agent
    // delivery semantics, so they get the same default announce behavior.
    const isDetachedDeliveryJob =
      sessionTarget === "isolated" ||
      sessionTarget === "current" ||
      sessionTarget.startsWith("session:") ||
      (sessionTarget === "" && (payloadKind === "agentTurn" || payloadKind === "command"));
    const hasDelivery = "delivery" in next && next.delivery !== undefined;
    if (
      !hasDelivery &&
      isDetachedDeliveryJob &&
      (payloadKind === "agentTurn" || payloadKind === "command")
    ) {
      next.delivery = { mode: "announce" };
    }
  }

  return next;
}

/** Normalizes a raw cron create request and applies create-time defaults. */
export function normalizeCronJobCreate(
  raw: unknown,
  options?: Omit<NormalizeOptions, "applyDefaults">,
): CronJobCreate | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: true,
    ...options,
  }) as CronJobCreate | null;
}

/** Normalizes a raw cron patch request without filling omitted fields. */
export function normalizeCronJobPatch(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobPatch | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: false,
    ...options,
  }) as CronJobPatch | null;
}
