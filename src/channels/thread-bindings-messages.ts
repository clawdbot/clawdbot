/**
 * Channel-neutral thread-binding message builders shared by plugins, ACP focus, and subagent flows.
 * Keep text system-prefixed and compact because callers post it directly into user-visible threads.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { prefixSystemMessage } from "../infra/system-message.js";

const DEFAULT_THREAD_BINDING_FAREWELL_TEXT =
  "Session ended. Messages here will no longer be routed.";

function normalizeThreadBindingDurationMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  const durationMs = Math.floor(raw);
  if (durationMs < 0) {
    return 0;
  }
  return durationMs;
}

/** Formats thread-binding timeout durations for compact user-facing messages. */
export function formatThreadBindingDurationLabel(durationMs: number): string {
  if (durationMs <= 0) {
    return "disabled";
  }
  if (durationMs < 60_000) {
    return "<1m";
  }
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes % 60 === 0) {
    return `${Math.floor(totalMinutes / 60)}h`;
  }
  return `${totalMinutes}m`;
}

/** Builds the native thread name for a focused thread-bound session. */
export function resolveThreadBindingThreadName(params: {
  agentId?: string;
  label?: string;
}): string {
  const label = normalizeOptionalString(params.label);
  const base = label || normalizeOptionalString(params.agentId) || "agent";
  const raw = `🤖 ${base}`.replace(/\s+/g, " ").trim();
  // Native channel thread names have tight limits; keep generated names bounded.
  return truncateUtf16Safe(raw, 100);
}

/** Builds the system-prefixed intro text posted when a thread binding becomes active. */
export function resolveThreadBindingIntroText(params: {
  agentId?: string;
  label?: string;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  sessionCwd?: string;
  sessionDetails?: string[];
}): string {
  const label = normalizeOptionalString(params.label);
  const base = label || normalizeOptionalString(params.agentId) || "agent";
  const normalized = truncateUtf16Safe(base.replace(/\s+/g, " ").trim(), 100) || "agent";
  const idleTimeoutMs = normalizeThreadBindingDurationMs(params.idleTimeoutMs);
  const maxAgeMs = normalizeThreadBindingDurationMs(params.maxAgeMs);
  const cwd = normalizeOptionalString(params.sessionCwd);
  const details = (params.sessionDetails ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (cwd) {
    details.unshift(`cwd: ${cwd}`);
  }

  const lifecycle: string[] = [];
  if (idleTimeoutMs > 0) {
    lifecycle.push(
      `idle auto-unfocus after ${formatThreadBindingDurationLabel(idleTimeoutMs)} inactivity`,
    );
  }
  if (maxAgeMs > 0) {
    lifecycle.push(`max age ${formatThreadBindingDurationLabel(maxAgeMs)}`);
  }

  const intro =
    lifecycle.length > 0
      ? `${normalized} session active (${lifecycle.join("; ")}). Messages here go directly to this session.`
      : `${normalized} session active. Messages here go directly to this session.`;

  if (details.length === 0) {
    return prefixSystemMessage(intro);
  }
  return prefixSystemMessage(`${intro}\n${details.join("\n")}`);
}

/** Builds the system-prefixed farewell text posted when a thread binding ends. */
export function resolveThreadBindingFarewellText(params: {
  reason?: string;
  farewellText?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
}): string {
  const custom = normalizeOptionalString(params.farewellText);
  if (custom) {
    return prefixSystemMessage(custom);
  }

  if (params.reason === "idle-expired") {
    const label = formatThreadBindingDurationLabel(
      normalizeThreadBindingDurationMs(params.idleTimeoutMs),
    );
    return prefixSystemMessage(
      `Session ended automatically after ${label} of inactivity. Messages here will no longer be routed.`,
    );
  }

  if (params.reason === "max-age-expired") {
    const label = formatThreadBindingDurationLabel(
      normalizeThreadBindingDurationMs(params.maxAgeMs),
    );
    return prefixSystemMessage(
      `Session ended automatically at max age of ${label}. Messages here will no longer be routed.`,
    );
  }

  return prefixSystemMessage(DEFAULT_THREAD_BINDING_FAREWELL_TEXT);
}
