import { randomUUID } from "node:crypto";
import { parseAbsoluteTimeMs } from "../cron/parse.js";
import { coerceFiniteScheduleNumber } from "../cron/schedule.js";
import { inferLegacyName } from "../cron/service/normalize.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "../cron/stagger.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "../shared/string-coerce.js";
import { normalizeLegacyDeliveryInput } from "./doctor-cron-legacy-delivery.js";
import {
  hasLegacyOpenAICodexCronModelRef,
  migrateLegacyCronPayload,
} from "./doctor-cron-payload-migration.js";

type CronStoreIssueKey =
  | "jobId"
  | "missingId"
  | "nonStringId"
  | "legacyScheduleString"
  | "legacyScheduleCron"
  | "legacyPayloadKind"
  | "legacyPayloadCodexModel"
  | "legacyPayloadProvider"
  | "legacyTopLevelPayloadFields"
  | "legacyTopLevelDeliveryFields"
  | "legacyDeliveryMode";

type CronStoreIssues = Partial<Record<CronStoreIssueKey, number>>;

type NormalizeCronStoreJobsResult = {
  issues: CronStoreIssues;
  jobs: Array<Record<string, unknown>>;
  mutated: boolean;
};

function incrementIssue(issues: CronStoreIssues, key: CronStoreIssueKey) {
  issues[key] = (issues[key] ?? 0) + 1;
}

function normalizeStoredCronJobIdentity(raw: Record<string, unknown>): {
  mutated: boolean;
  legacyJobIdIssue: boolean;
  missingIdIssue: boolean;
  nonStringIdIssue: boolean;
} {
  const hadIdKey = "id" in raw;
  const hadJobIdKey = "jobId" in raw;
  const id = normalizeOptionalStringifiedId(raw.id);
  const legacyJobId = normalizeOptionalStringifiedId(raw.jobId);
  const canonicalId = id ?? legacyJobId ?? `cron-${randomUUID()}`;
  const nonStringIdIssue = hadIdKey && raw.id != null && typeof raw.id !== "string";
  const missingIdIssue = !id && !legacyJobId;
  let mutated = false;

  if (raw.id !== canonicalId) {
    raw.id = canonicalId;
    mutated = true;
  }
  if (hadJobIdKey) {
    delete raw.jobId;
    mutated = true;
  }

  return {
    mutated,
    legacyJobIdIssue: hadJobIdKey,
    missingIdIssue,
    nonStringIdIssue,
  };
}

function normalizePayloadKind(payload: Record<string, unknown>) {
  const raw = normalizeOptionalLowercaseString(payload.kind) ?? "";
  if (raw === "agentturn") {
    if (payload.kind !== "agentTurn") {
      payload.kind = "agentTurn";
      return true;
    }
    return false;
  }
  if (raw === "systemevent") {
    if (payload.kind !== "systemEvent") {
      payload.kind = "systemEvent";
      return true;
    }
    return false;
  }
  return false;
}

function inferPayloadIfMissing(raw: Record<string, unknown>) {
  const message = normalizeOptionalString(raw.message) ?? "";
  const text = normalizeOptionalString(raw.text) ?? "";
  const command = normalizeOptionalString(raw.command) ?? "";
  if (message) {
    raw.payload = { kind: "agentTurn", message };
    return true;
  }
  if (text) {
    raw.payload = { kind: "systemEvent", text };
    return true;
  }
  if (command) {
    raw.payload = { kind: "systemEvent", text: command };
    return true;
  }
  return false;
}

function copyTopLevelAgentTurnFields(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  let mutated = false;

  const copyTrimmedString = (field: "model" | "thinking") => {
    const existing = normalizeOptionalString(payload[field]);
    if (existing) {
      return;
    }
    const value = normalizeOptionalString(raw[field]);
    if (value) {
      payload[field] = value;
      mutated = true;
    }
  };
  copyTrimmedString("model");
  copyTrimmedString("thinking");

  if (
    typeof payload.timeoutSeconds !== "number" &&
    typeof raw.timeoutSeconds === "number" &&
    Number.isFinite(raw.timeoutSeconds)
  ) {
    payload.timeoutSeconds = Math.max(0, Math.floor(raw.timeoutSeconds));
    mutated = true;
  }

  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof raw.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = raw.allowUnsafeExternalContent;
    mutated = true;
  }

  if (typeof payload.deliver !== "boolean" && typeof raw.deliver === "boolean") {
    payload.deliver = raw.deliver;
    mutated = true;
  }
  const channel = normalizeOptionalString(raw.channel);
  if (typeof payload.channel !== "string" && channel) {
    payload.channel = channel;
    mutated = true;
  }
  const to = normalizeOptionalString(raw.to);
  if (typeof payload.to !== "string" && to) {
    payload.to = to;
    mutated = true;
  }
  const rawThreadId = normalizeOptionalString(raw.threadId);
  if (
    !("threadId" in payload) &&
    ((typeof raw.threadId === "number" && Number.isFinite(raw.threadId)) || Boolean(rawThreadId))
  ) {
    payload.threadId = rawThreadId ?? raw.threadId;
    mutated = true;
  }
  if (
    typeof payload.bestEffortDeliver !== "boolean" &&
    typeof raw.bestEffortDeliver === "boolean"
  ) {
    payload.bestEffortDeliver = raw.bestEffortDeliver;
    mutated = true;
  }
  const provider = normalizeOptionalString(raw.provider);
  if (typeof payload.provider !== "string" && provider) {
    payload.provider = provider;
    mutated = true;
  }

  return mutated;
}

function stripLegacyTopLevelFields(raw: Record<string, unknown>) {
  if ("model" in raw) {
    delete raw.model;
  }
  if ("thinking" in raw) {
    delete raw.thinking;
  }
  if ("timeoutSeconds" in raw) {
    delete raw.timeoutSeconds;
  }
  if ("allowUnsafeExternalContent" in raw) {
    delete raw.allowUnsafeExternalContent;
  }
  if ("message" in raw) {
    delete raw.message;
  }
  if ("text" in raw) {
    delete raw.text;
  }
  if ("deliver" in raw) {
    delete raw.deliver;
  }
  if ("channel" in raw) {
    delete raw.channel;
  }
  if ("to" in raw) {
    delete raw.to;
  }
  if ("threadId" in raw) {
    delete raw.threadId;
  }
  if ("bestEffortDeliver" in raw) {
    delete raw.bestEffortDeliver;
  }
  if ("provider" in raw) {
    delete raw.provider;
  }
  if ("command" in raw) {
    delete raw.command;
  }
  if ("timeout" in raw) {
    delete raw.timeout;
  }
}

export function normalizeStoredCronJobs(
  jobs: Array<Record<string, unknown>>,
): NormalizeCronStoreJobsResult {
  const issues: CronStoreIssues = {};
  let mutated = false;

  for (const raw of jobs) {
    const jobIssues = new Set<CronStoreIssueKey>();
    const trackIssue = (key: CronStoreIssueKey) => {
      if (jobIssues.has(key)) {
        return;
      }
      jobIssues.add(key);
      incrementIssue(issues, key);
    };

    const state = raw.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      raw.state = {};
      mutated = true;
    }

    const idNorm = normalizeStoredCronJobIdentity(raw);
    if (idNorm.mutated) {
      mutated = true;
    }
    if (idNorm.legacyJobIdIssue) {
      trackIssue("jobId");
    }
    if (idNorm.missingIdIssue) {
      trackIssue("missingId");
    }
    if (idNorm.nonStringIdIssue) {
      trackIssue("nonStringId");
    }

    if (typeof raw.schedule === "string") {
      const expr = raw.schedule.trim();
      raw.schedule = { kind: "cron", expr };
      mutated = true;
      trackIssue("legacyScheduleString");
    }

    const nameRaw = raw.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      raw.name = inferLegacyName({
        schedule: raw.schedule as never,
        payload: raw.payload as never,
      });
      mutated = true;
    } else {
      raw.name = nameRaw.trim();
    }

    const desc = normalizeOptionalString(raw.description);
    if (raw.description !== desc) {
      raw.description = desc;
      mutated = true;
    }

    if ("sessionKey" in raw) {
      const sessionKey =
        typeof raw.sessionKey === "string" ? normalizeOptionalString(raw.sessionKey) : undefined;
      if (raw.sessionKey !== sessionKey) {
        raw.sessionKey = sessionKey;
        mutated = true;
      }
    }

    if (typeof raw.enabled !== "boolean") {
      raw.enabled = true;
      mutated = true;
    }

    const wakeModeRaw = normalizeOptionalLowercaseString(raw.wakeMode) ?? "";
    if (wakeModeRaw === "next-heartbeat") {
      if (raw.wakeMode !== "next-heartbeat") {
        raw.wakeMode = "next-heartbeat";
        mutated = true;
      }
    } else if (wakeModeRaw === "now") {
      if (raw.wakeMode !== "now") {
        raw.wakeMode = "now";
        mutated = true;
      }
    } else {
      raw.wakeMode = "now";
      mutated = true;
    }

    const payload = raw.payload;
    if (
      (!payload || typeof payload !== "object" || Array.isArray(payload)) &&
      inferPayloadIfMissing(raw)
    ) {
      mutated = true;
      trackIssue("legacyTopLevelPayloadFields");
    }

    const payloadRecord =
      raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : null;

    if (payloadRecord) {
      if (normalizePayloadKind(payloadRecord)) {
        mutated = true;
        trackIssue("legacyPayloadKind");
      }
      if (!payloadRecord.kind) {
        if (normalizeOptionalString(payloadRecord.message)) {
          payloadRecord.kind = "agentTurn";
          mutated = true;
          trackIssue("legacyPayloadKind");
        } else if (normalizeOptionalString(payloadRecord.text)) {
          payloadRecord.kind = "systemEvent";
          mutated = true;
          trackIssue("legacyPayloadKind");
        }
      }
      if (payloadRecord.kind === "agentTurn" && copyTopLevelAgentTurnFields(raw, payloadRecord)) {
        mutated = true;
      }
    }

    const hadLegacyTopLevelPayloadFields =
      "model" in raw ||
      "thinking" in raw ||
      "timeoutSeconds" in raw ||
      "allowUnsafeExternalContent" in raw ||
      "message" in raw ||
      "text" in raw ||
      "command" in raw ||
      "timeout" in raw;
    const hadLegacyTopLevelDeliveryFields =
      "deliver" in raw ||
      "channel" in raw ||
      "to" in raw ||
      "threadId" in raw ||
      "bestEffortDeliver" in raw ||
      "provider" in raw;
    if (hadLegacyTopLevelPayloadFields || hadLegacyTopLevelDeliveryFields) {
      stripLegacyTopLevelFields(raw);
      mutated = true;
      if (hadLegacyTopLevelPayloadFields) {
        trackIssue("legacyTopLevelPayloadFields");
      }
      if (hadLegacyTopLevelDeliveryFields) {
        trackIssue("legacyTopLevelDeliveryFields");
      }
    }

    if (payloadRecord) {
      const hadLegacyPayloadProvider = Boolean(normalizeOptionalString(payloadRecord.provider));
      const hadLegacyPayloadCodexModel = hasLegacyOpenAICodexCronModelRef(payloadRecord);
      if (migrateLegacyCronPayload(payloadRecord)) {
        mutated = true;
        if (hadLegacyPayloadCodexModel) {
          trackIssue("legacyPayloadCodexModel");
        }
        if (hadLegacyPayloadProvider) {
          trackIssue("legacyPayloadProvider");
        }
      }
    }

    const schedule = raw.schedule;
    if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
      const sched = schedule as Record<string, unknown>;
      const kind = normalizeOptionalLowercaseString(sched.kind) ?? "";
      if (!kind && ("at" in sched || "atMs" in sched)) {
        sched.kind = "at";
        mutated = true;
      }
      const atRaw = normalizeOptionalString(sched.at) ?? "";
      const atMsRaw = sched.atMs;
      const parsedAtMs =
        typeof atMsRaw === "number"
          ? atMsRaw
          : typeof atMsRaw === "string"
            ? parseAbsoluteTimeMs(atMsRaw)
            : atRaw
              ? parseAbsoluteTimeMs(atRaw)
              : null;
      if (parsedAtMs !== null) {
        sched.at = new Date(parsedAtMs).toISOString();
        if ("atMs" in sched) {
          delete sched.atMs;
        }
        mutated = true;
      }

      const everyMsRaw = sched.everyMs;
      const everyMsCoerced = coerceFiniteScheduleNumber(everyMsRaw);
      const everyMs = everyMsCoerced !== undefined ? Math.floor(everyMsCoerced) : null;
      if (everyMs !== null && everyMsRaw !== everyMs) {
        sched.everyMs = everyMs;
        mutated = true;
      }
      if ((kind === "every" || sched.kind === "every") && everyMs !== null) {
        const anchorRaw = sched.anchorMs;
        const anchorCoerced = coerceFiniteScheduleNumber(anchorRaw);
        const normalizedAnchor =
          anchorCoerced !== undefined
            ? Math.max(0, Math.floor(anchorCoerced))
            : typeof raw.createdAtMs === "number" && Number.isFinite(raw.createdAtMs)
              ? Math.max(0, Math.floor(raw.createdAtMs))
              : typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs)
                ? Math.max(0, Math.floor(raw.updatedAtMs))
                : null;
        if (normalizedAnchor !== null && anchorRaw !== normalizedAnchor) {
          sched.anchorMs = normalizedAnchor;
          mutated = true;
        }
      }

      const exprRaw = normalizeOptionalString(sched.expr) ?? "";
      const legacyCronRaw = normalizeOptionalString(sched.cron) ?? "";
      let normalizedExpr = exprRaw;
      if (!normalizedExpr && legacyCronRaw) {
        normalizedExpr = legacyCronRaw;
        sched.expr = normalizedExpr;
        mutated = true;
        trackIssue("legacyScheduleCron");
      }
      if (typeof sched.expr === "string" && sched.expr !== normalizedExpr) {
        sched.expr = normalizedExpr;
        mutated = true;
      }
      if ("cron" in sched) {
        delete sched.cron;
        mutated = true;
        trackIssue("legacyScheduleCron");
      }
      if ((kind === "cron" || sched.kind === "cron") && normalizedExpr) {
        const explicitStaggerMs = normalizeCronStaggerMs(sched.staggerMs);
        const defaultStaggerMs = resolveDefaultCronStaggerMs(normalizedExpr);
        const targetStaggerMs = explicitStaggerMs ?? defaultStaggerMs;
        if (targetStaggerMs === undefined) {
          if ("staggerMs" in sched) {
            delete sched.staggerMs;
            mutated = true;
          }
        } else if (sched.staggerMs !== targetStaggerMs) {
          sched.staggerMs = targetStaggerMs;
          mutated = true;
        }
      }
    }

    const delivery = raw.delivery;
    if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
      const modeRaw = (delivery as { mode?: unknown }).mode;
      if (typeof modeRaw === "string") {
        const lowered = normalizeOptionalLowercaseString(modeRaw) ?? "";
        if (lowered === "deliver") {
          (delivery as { mode?: unknown }).mode = "announce";
          mutated = true;
          trackIssue("legacyDeliveryMode");
        }
      } else if (modeRaw === undefined || modeRaw === null) {
        (delivery as { mode?: unknown }).mode = "announce";
        mutated = true;
      }
    }

    const isolation = raw.isolation;
    if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
      delete raw.isolation;
      mutated = true;
    }

    const payloadKind =
      payloadRecord && typeof payloadRecord.kind === "string" ? payloadRecord.kind : "";
    const rawSessionTarget = normalizeOptionalString(raw.sessionTarget) ?? "";
    const loweredSessionTarget = normalizeLowercaseStringOrEmpty(rawSessionTarget);
    if (loweredSessionTarget === "main" || loweredSessionTarget === "isolated") {
      if (raw.sessionTarget !== loweredSessionTarget) {
        raw.sessionTarget = loweredSessionTarget;
        mutated = true;
      }
    } else if (loweredSessionTarget.startsWith("session:")) {
      const customSessionId = rawSessionTarget.slice(8).trim();
      if (customSessionId) {
        const normalizedSessionTarget = `session:${customSessionId}`;
        if (raw.sessionTarget !== normalizedSessionTarget) {
          raw.sessionTarget = normalizedSessionTarget;
          mutated = true;
        }
      }
    } else if (loweredSessionTarget === "current") {
      if (raw.sessionTarget !== "isolated") {
        raw.sessionTarget = "isolated";
        mutated = true;
      }
    } else {
      const inferredSessionTarget = payloadKind === "agentTurn" ? "isolated" : "main";
      if (raw.sessionTarget !== inferredSessionTarget) {
        raw.sessionTarget = inferredSessionTarget;
        mutated = true;
      }
    }

    const sessionTarget = normalizeOptionalLowercaseString(raw.sessionTarget) ?? "";
    const isIsolatedAgentTurn =
      sessionTarget === "isolated" ||
      sessionTarget === "current" ||
      sessionTarget.startsWith("session:") ||
      (sessionTarget === "" && payloadKind === "agentTurn");
    const hasDelivery = delivery && typeof delivery === "object" && !Array.isArray(delivery);
    const normalizedLegacy = normalizeLegacyDeliveryInput({
      delivery: hasDelivery ? (delivery as Record<string, unknown>) : null,
      payload: payloadRecord,
    });

    if (isIsolatedAgentTurn && payloadKind === "agentTurn") {
      if (!hasDelivery && normalizedLegacy.delivery) {
        raw.delivery = normalizedLegacy.delivery;
        mutated = true;
      } else if (!hasDelivery) {
        raw.delivery = { mode: "announce" };
        mutated = true;
      } else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
        raw.delivery = normalizedLegacy.delivery;
        mutated = true;
      }
    } else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
      raw.delivery = normalizedLegacy.delivery;
      mutated = true;
    }
  }

  return { issues, jobs, mutated };
}
