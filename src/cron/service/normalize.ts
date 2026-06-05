/** Name, agent id, and payload text normalization helpers for cron service ops. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { CronPayload } from "../types.js";

/** Normalizes a required cron job name and throws the public validation error when absent. */
export function normalizeRequiredName(raw: unknown) {
  if (typeof raw !== "string") {
    throw new Error("cron job name is required");
  }
  const name = raw.trim();
  if (!name) {
    throw new Error("cron job name is required");
  }
  return name;
}

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) {
    return input;
  }
  return `${truncateUtf16Safe(input, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/** Normalizes optional cron agent ids through the canonical session-key agent id rules. */
export function normalizeOptionalAgentId(raw: unknown) {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  return normalizeAgentId(trimmed);
}

/** Infers a compact cron job name from payload text first, then schedule shape. */
export function inferCronJobName(job: {
  schedule?: { kind?: unknown; everyMs?: unknown; expr?: unknown };
  payload?: { kind?: unknown; text?: unknown; message?: unknown };
}) {
  const text =
    job?.payload?.kind === "systemEvent" && typeof job.payload.text === "string"
      ? job.payload.text
      : job?.payload?.kind === "agentTurn" && typeof job.payload.message === "string"
        ? job.payload.message
        : "";
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  if (firstLine) {
    // Names appear in CLI lists and alerts; keep them single-line and UTF-16
    // safe so emoji/surrogate pairs are not split by truncation.
    return truncateText(firstLine, 60);
  }

  const kind = typeof job?.schedule?.kind === "string" ? job.schedule.kind : "";
  if (kind === "cron" && typeof job?.schedule?.expr === "string") {
    return `Cron: ${truncateText(job.schedule.expr, 52)}`;
  }
  if (kind === "every" && typeof job?.schedule?.everyMs === "number") {
    return `Every: ${job.schedule.everyMs}ms`;
  }
  if (kind === "at") {
    return "One-shot";
  }
  return "Cron job";
}

/** Extracts the executable text from cron payload variants for main-session queueing. */
export function normalizePayloadToSystemText(payload: CronPayload) {
  if (payload.kind === "systemEvent") {
    return typeof payload.text === "string" ? payload.text.trim() : "";
  }
  return typeof payload.message === "string" ? payload.message.trim() : "";
}
