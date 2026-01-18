import type { SessionConfig } from "../types.base.js";
import { DEFAULT_IDLE_MINUTES } from "./types.js";

export type SessionResetMode = "daily" | "idle";
export type SessionResetType = "dm" | "group" | "thread";

export type SessionResetPolicy = {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes?: number;
};

export type SessionFreshness = {
  fresh: boolean;
  dailyResetAt?: number;
  idleExpiresAt?: number;
};

export const DEFAULT_RESET_MODE: SessionResetMode = "daily";
export const DEFAULT_RESET_AT_HOUR = 4;

const THREAD_SESSION_MARKERS = [":thread:", ":topic:"];
const GROUP_SESSION_MARKERS = [":group:", ":channel:"];

export function isThreadSessionKey(sessionKey?: string | null): boolean {
  const normalized = (sessionKey ?? "").toLowerCase();
  if (!normalized) return false;
  return THREAD_SESSION_MARKERS.some((marker) => normalized.includes(marker));
}

export function resolveSessionResetType(params: {
  sessionKey?: string | null;
  isGroup?: boolean;
  isThread?: boolean;
}): SessionResetType {
  if (params.isThread || isThreadSessionKey(params.sessionKey)) return "thread";
  if (params.isGroup) return "group";
  const normalized = (params.sessionKey ?? "").toLowerCase();
  if (GROUP_SESSION_MARKERS.some((marker) => normalized.includes(marker))) return "group";
  return "dm";
}

export function resolveThreadFlag(params: {
  sessionKey?: string | null;
  messageThreadId?: string | number | null;
  threadLabel?: string | null;
  threadStarterBody?: string | null;
  parentSessionKey?: string | null;
}): boolean {
  if (params.messageThreadId != null) return true;
  if (params.threadLabel?.trim()) return true;
  if (params.threadStarterBody?.trim()) return true;
  if (params.parentSessionKey?.trim()) return true;
  return isThreadSessionKey(params.sessionKey);
}

export function resolveDailyResetAtMs(now: number, atHour: number): number {
  const normalizedAtHour = normalizeResetAtHour(atHour);
  const resetAt = new Date(now);
  resetAt.setHours(normalizedAtHour, 0, 0, 0);
  if (now < resetAt.getTime()) {
    resetAt.setDate(resetAt.getDate() - 1);
  }
  return resetAt.getTime();
}

export function resolveSessionResetPolicy(params: {
  sessionCfg?: SessionConfig;
  resetType: SessionResetType;
  idleMinutesOverride?: number;
}): SessionResetPolicy {
  const sessionCfg = params.sessionCfg;
  const baseReset = sessionCfg?.reset;
  const typeReset = sessionCfg?.resetByType?.[params.resetType];
  const hasExplicitReset = Boolean(baseReset || sessionCfg?.resetByType);
  const legacyIdleMinutes = sessionCfg?.idleMinutes;
  const mode =
    typeReset?.mode ??
    baseReset?.mode ??
    (!hasExplicitReset && legacyIdleMinutes != null ? "idle" : DEFAULT_RESET_MODE);
  const atHour = normalizeResetAtHour(
    typeReset?.atHour ?? baseReset?.atHour ?? DEFAULT_RESET_AT_HOUR,
  );
  const idleMinutesRaw =
    params.idleMinutesOverride ??
    typeReset?.idleMinutes ??
    baseReset?.idleMinutes ??
    legacyIdleMinutes;

  let idleMinutes: number | undefined;
  if (idleMinutesRaw != null) {
    const normalized = Math.floor(idleMinutesRaw);
    if (Number.isFinite(normalized)) {
      idleMinutes = Math.max(normalized, 1);
    }
  } else if (mode === "idle") {
    idleMinutes = DEFAULT_IDLE_MINUTES;
  }

  return { mode, atHour, idleMinutes };
}

export function evaluateSessionFreshness(params: {
  updatedAt: number;
  now: number;
  policy: SessionResetPolicy;
}): SessionFreshness {
  const dailyResetAt =
    params.policy.mode === "daily"
      ? resolveDailyResetAtMs(params.now, params.policy.atHour)
      : undefined;
  const idleExpiresAt =
    params.policy.idleMinutes != null
      ? params.updatedAt + params.policy.idleMinutes * 60_000
      : undefined;
  const staleDaily = dailyResetAt != null && params.updatedAt < dailyResetAt;
  const staleIdle = idleExpiresAt != null && params.now > idleExpiresAt;
  return {
    fresh: !(staleDaily || staleIdle),
    dailyResetAt,
    idleExpiresAt,
  };
}

function normalizeResetAtHour(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RESET_AT_HOUR;
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized)) return DEFAULT_RESET_AT_HOUR;
  if (normalized < 0) return 0;
  if (normalized > 23) return 23;
  return normalized;
}
