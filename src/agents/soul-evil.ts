import fs from "node:fs/promises";
import path from "node:path";

import { parseDurationMs } from "../cli/parse-duration.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import {
  DEFAULT_SOUL_EVIL_FILENAME,
  DEFAULT_SOUL_FILENAME,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

type SoulEvilDecision = {
  useEvil: boolean;
  reason?: "purge" | "chance";
  fileName: string;
};

type SoulEvilCheckParams = {
  config?: ClawdbotConfig;
  now?: Date;
  random?: () => number;
};

type SoulEvilLog = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

function clampChance(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function resolveUserTimezone(config?: ClawdbotConfig): string {
  const trimmed = config?.agent?.userTimezone?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(
        new Date(),
      );
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
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

function minutesInTimezone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (!map.hour || !map.minute) return null;
    const hour = Number.parseInt(map.hour, 10);
    const minute = Number.parseInt(map.minute, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
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

  const durationMinutes = Math.ceil(durationMs / 60000);
  if (durationMinutes >= 24 * 60) return true;

  const nowMinutes = minutesInTimezone(params.now, params.timeZone);
  if (nowMinutes === null) return false;

  const endMinutes = startMinutes + durationMinutes;
  if (endMinutes < 24 * 60) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  const wrappedEnd = endMinutes % (24 * 60);
  return nowMinutes >= startMinutes || nowMinutes < wrappedEnd;
}

export function decideSoulEvil(params: SoulEvilCheckParams): SoulEvilDecision {
  const evil = params.config?.agent?.soulEvil;
  const fileName = evil?.file?.trim() || DEFAULT_SOUL_EVIL_FILENAME;
  if (!evil) {
    return { useEvil: false, fileName };
  }

  const timeZone = resolveUserTimezone(params.config);
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
  config?: ClawdbotConfig;
  now?: Date;
  random?: () => number;
  log?: SoulEvilLog;
}): Promise<WorkspaceBootstrapFile[]> {
  const decision = decideSoulEvil({
    config: params.config,
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

  let replaced = false;
  const updated = params.files.map((file) => {
    if (file.name !== DEFAULT_SOUL_FILENAME) return file;
    replaced = true;
    return { ...file, content: evilContent, missing: false };
  });

  if (!replaced) {
    updated.push({
      name: DEFAULT_SOUL_FILENAME,
      path: path.join(workspaceDir, DEFAULT_SOUL_FILENAME),
      content: evilContent,
      missing: false,
    });
  }

  params.log?.debug?.(
    `SOUL_EVIL active (${decision.reason ?? "unknown"}) using ${decision.fileName}`,
  );

  return updated;
}
