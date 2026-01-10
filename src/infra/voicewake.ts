import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["clawd", "claude", "computer"];

function resolvePath(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "voicewake.json");
}

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => (typeof w === "string" ? w.trim() : ""))
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJSONAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

let lock: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let release: (() => void) | undefined;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

export async function loadVoiceWakeConfig(
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const filePath = resolvePath(baseDir);
  const existing = await readJSON<VoiceWakeConfig>(filePath);
  if (!existing) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  return {
    triggers: sanitizeTriggers(existing.triggers),
    updatedAtMs:
      typeof existing.updatedAtMs === "number" && existing.updatedAtMs > 0
        ? existing.updatedAtMs
        : 0,
  };
}

export async function setVoiceWakeTriggers(
  triggers: string[],
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
  const filePath = resolvePath(baseDir);
  return await withLock(async () => {
    const next: VoiceWakeConfig = {
      triggers: sanitized,
      updatedAtMs: Date.now(),
    };
    await writeJSONAtomic(filePath, next);
    return next;
  });
}
