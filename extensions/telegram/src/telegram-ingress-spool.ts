import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const SPOOL_VERSION = 1;

type TelegramSpooledUpdatePayload = {
  version: number;
  updateId: number;
  receivedAt: number;
  update: unknown;
};

export type TelegramSpooledUpdate = {
  updateId: number;
  path: string;
  update: unknown;
  receivedAt: number;
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveTelegramIngressSpoolDir(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const stateDir = resolveStateDir(params.env, os.homedir);
  return path.join(stateDir, "telegram", `ingress-spool-${normalizeAccountId(params.accountId)}`);
}

export function resolveTelegramUpdateId(update: unknown): number | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const value = (update as { update_id?: unknown }).update_id;
  return isValidUpdateId(value) ? value : null;
}

function spoolFileName(updateId: number): string {
  return `${String(updateId).padStart(16, "0")}.json`;
}

function parseSpooledUpdate(value: unknown, filePath: string): TelegramSpooledUpdate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as Partial<TelegramSpooledUpdatePayload>;
  if (payload.version !== SPOOL_VERSION || !isValidUpdateId(payload.updateId)) {
    return null;
  }
  return {
    updateId: payload.updateId,
    path: filePath,
    update: payload.update,
    receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0,
  };
}

export async function writeTelegramSpooledUpdate(params: {
  spoolDir: string;
  update: unknown;
  now?: number;
}): Promise<number> {
  const updateId = resolveTelegramUpdateId(params.update);
  if (updateId === null) {
    throw new Error("Telegram update missing numeric update_id.");
  }
  await fs.mkdir(params.spoolDir, { recursive: true });
  const targetPath = path.join(params.spoolDir, spoolFileName(updateId));
  const tempPath = path.join(params.spoolDir, `${spoolFileName(updateId)}.${randomUUID()}.tmp`);
  const payload: TelegramSpooledUpdatePayload = {
    version: SPOOL_VERSION,
    updateId,
    receivedAt: params.now ?? Date.now(),
    update: params.update,
  };
  await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, targetPath);
  return updateId;
}

export async function listTelegramSpooledUpdates(params: {
  spoolDir: string;
  limit?: number;
}): Promise<TelegramSpooledUpdate[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(params.spoolDir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const files = entries
    .filter((entry) => entry.endsWith(".json"))
    .toSorted()
    .slice(0, Math.max(1, params.limit ?? 100));
  const updates: TelegramSpooledUpdate[] = [];
  for (const file of files) {
    const filePath = path.join(params.spoolDir, file);
    const { value } = await readJsonFileWithFallback<unknown>(filePath, null);
    const parsed = parseSpooledUpdate(value, filePath);
    if (parsed) {
      updates.push(parsed);
    }
  }
  return updates;
}

export async function deleteTelegramSpooledUpdate(update: TelegramSpooledUpdate): Promise<void> {
  try {
    await fs.unlink(update.path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return;
    }
    throw err;
  }
}
