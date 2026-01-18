import fs from "node:fs/promises";
import path from "node:path";

import { resolveUserTimezone } from "../agents/date-time.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { resolveUserPath } from "../utils.js";

export const DEFAULT_SOUL_EVIL_FILENAME = "SOUL_EVIL.md";

export type SoulEvilConfig = {
  /** Alternate SOUL file name (default: SOUL_EVIL.md). */
  file?: string;
  /** Random chance (0-1) to use SOUL_EVIL on any message. */
  chance?: number;
  /** Daily purge window (static time each day). */
  purge?: {
    /** Start time in 24h HH:mm format. */
    at?: string;
    /** Duration (e.g. 30s, 10m, 1h). */
    duration?: string;
  };
};

type SoulEvilDecision = {
  useEvil: boolean;
  reason?: "purge" | "chance";
  fileName: string;
};

type SoulEvilCheckParams = {
  config?: SoulEvilConfig;
  userTimezone?: string;
  now?: Date;
  random?: () => number;
};

type SoulEvilLog = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

export function resolveSoulEvilConfigFromHook(
  entry: Record<string, unknown> | undefined,
  log?: SoulEvilLog,
): SoulEvilConfig | null {
  if (!entry) return null;
  const file = typeof entry.file === "string" ? entry.file : undefined;
  if (entry.file !== undefined && !file) {
    log?.warn?.("soul-evil config: file must be a string");
  }

  let chance: number | undefined;
  if (entry.chance !== undefined) {
    if (typeof entry.chance === "number" && Number.isFinite(entry.chance)) {
      chance = entry.chance;
    } else {
      log?.warn?.("soul-evil config: chance must be a number");
    }
  }

  let purge: SoulEvilConfig["purge"];
  if (entry.purge && typeof entry.purge === "object") {
    const at =
      typeof (entry.purge as { at?: unknown }).at === "string"
        ? (entry.purge as { at?: string }).at
        : undefined;
    const duration =
      typeof (entry.purge as { duration?: unknown }).duration === "string"
        ? (entry.purge as { duration?: string }).duration
        : undefined;
    if ((entry.purge as { at?: unknown }).at !== undefined && !at) {
      log?.warn?.("soul-evil config: purge.at must be a string");
    }
    if ((entry.purge as { duration?: unknown }).duration !== undefined && !duration) {
      log?.warn?.("soul-evil config: purge.duration must be a string");
    }
    purge = { at, duration };
  } else if (entry.purge !== undefined) {
    log?.warn?.("soul-evil config: purge must be an object");
  }

  if (!file && chance === undefined && !purge) return null;
  return { file, chance, purge };
}

function clampChance(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parsePurgeAt(raw?: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (!match) return null;
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function timeOfDayMsInTimezone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (!map.hour || !map.minute || !map.second) return null;
    const hour = Number.parseInt(map.hour, 10);
    const minute = Number.parseInt(map.minute, 10);
    const second = Number.parseInt(map.second, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) {
      return null;
    }
    return (hour * 3600 + minute * 60 + second) * 1000 + date.getMilliseconds();
  } catch {
    return null;
  }
}

function isWithinDailyPurgeWindow(params: {
  at?: string;
  duration?: string;
  now: Date;
  timeZone: string;
}): boolean {
  if (!params.at || !params.duration) return false;
  const startMinutes = parsePurgeAt(params.at);
  if (startMinutes === null) return false;

  let durationMs: number;
  try {
    durationMs = parseDurationMs(params.duration, { defaultUnit: "m" });
  } catch {
    return false;
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;

  const dayMs = 24 * 60 * 60 * 1000;
  if (durationMs >= dayMs) return true;

  const nowMs = timeOfDayMsInTimezone(params.now, params.timeZone);
  if (nowMs === null) return false;

  const startMs = startMinutes * 60 * 1000;
  const endMs = startMs + durationMs;
  if (endMs < dayMs) {
    return nowMs >= startMs && nowMs < endMs;
  }
  const wrappedEnd = endMs % dayMs;
  return nowMs >= startMs || nowMs < wrappedEnd;
}

export function decideSoulEvil(params: SoulEvilCheckParams): SoulEvilDecision {
  const evil = params.config;
  const fileName = evil?.file?.trim() || DEFAULT_SOUL_EVIL_FILENAME;
  if (!evil) {
    return { useEvil: false, fileName };
  }

  const timeZone = resolveUserTimezone(params.userTimezone);
  const now = params.now ?? new Date();
  const inPurge = isWithinDailyPurgeWindow({
    at: evil.purge?.at,
    duration: evil.purge?.duration,
    now,
    timeZone,
  });
  if (inPurge) {
    return { useEvil: true, reason: "purge", fileName };
  }

  const chance = clampChance(evil.chance);
  if (chance > 0) {
    const random = params.random ?? Math.random;
    if (random() < chance) {
      return { useEvil: true, reason: "chance", fileName };
    }
  }

  return { useEvil: false, fileName };
}

export async function applySoulEvilOverride(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: SoulEvilConfig;
  userTimezone?: string;
  now?: Date;
  random?: () => number;
  log?: SoulEvilLog;
}): Promise<WorkspaceBootstrapFile[]> {
  const decision = decideSoulEvil({
    config: params.config,
    userTimezone: params.userTimezone,
    now: params.now,
    random: params.random,
  });
  if (!decision.useEvil) return params.files;

  const workspaceDir = resolveUserPath(params.workspaceDir);
  const evilPath = path.join(workspaceDir, decision.fileName);
  let evilContent: string;
  try {
    evilContent = await fs.readFile(evilPath, "utf-8");
  } catch {
    params.log?.warn?.(
      `SOUL_EVIL active (${decision.reason ?? "unknown"}) but file missing: ${evilPath}`,
    );
    return params.files;
  }

  if (!evilContent.trim()) {
    params.log?.warn?.(
      `SOUL_EVIL active (${decision.reason ?? "unknown"}) but file empty: ${evilPath}`,
    );
    return params.files;
  }

  const hasSoulEntry = params.files.some((file) => file.name === "SOUL.md");
  if (!hasSoulEntry) {
    params.log?.warn?.(
      `SOUL_EVIL active (${decision.reason ?? "unknown"}) but SOUL.md not in bootstrap files`,
    );
    return params.files;
  }

  let replaced = false;
  const updated = params.files.map((file) => {
    if (file.name !== "SOUL.md") return file;
    replaced = true;
    return { ...file, content: evilContent, missing: false };
  });
  if (!replaced) return params.files;

  params.log?.debug?.(
    `SOUL_EVIL active (${decision.reason ?? "unknown"}) using ${decision.fileName}`,
  );

  return updated;
}
