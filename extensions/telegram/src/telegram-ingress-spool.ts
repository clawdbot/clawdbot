import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const SPOOL_VERSION = 1;
export const TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_UPDATE_PROCESS_ID = `${process.pid}:${randomUUID()}`;

type TelegramSpooledUpdateClaimOwner = {
  processId: string;
  processPid: number;
  claimedAt: number;
};

type TelegramSpooledUpdatePayload = {
  version: number;
  updateId: number;
  receivedAt: number;
  update: unknown;
  claim?: TelegramSpooledUpdateClaimOwner;
};

export type TelegramSpooledUpdate = {
  updateId: number;
  path: string;
  update: unknown;
  receivedAt: number;
  claim?: TelegramSpooledUpdateClaimOwner;
};

export type ClaimedTelegramSpooledUpdate = TelegramSpooledUpdate & {
  pendingPath: string;
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

function processingFileName(updateId: number): string {
  return `${spoolFileName(updateId)}.processing`;
}

function isProcessingFileName(fileName: string): boolean {
  return fileName.endsWith(".json.processing");
}

function pendingFileNameFromProcessing(fileName: string): string {
  return fileName.slice(0, -".processing".length);
}

function processingPath(spoolDir: string, updateId: number): string {
  return path.join(spoolDir, processingFileName(updateId));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function parseSpooledUpdate(value: unknown, filePath: string): TelegramSpooledUpdate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as Partial<TelegramSpooledUpdatePayload>;
  if (payload.version !== SPOOL_VERSION || !isValidUpdateId(payload.updateId)) {
    return null;
  }
  const update: TelegramSpooledUpdate = {
    updateId: payload.updateId,
    path: filePath,
    update: payload.update,
    receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0,
  };
  if (
    payload.claim &&
    typeof payload.claim.processId === "string" &&
    isValidUpdateId(payload.claim.processPid) &&
    typeof payload.claim.claimedAt === "number"
  ) {
    update.claim = payload.claim;
  }
  return update;
}

function buildClaimedPayload(update: TelegramSpooledUpdate): TelegramSpooledUpdatePayload {
  return {
    version: SPOOL_VERSION,
    updateId: update.updateId,
    receivedAt: update.receivedAt,
    update: update.update,
    claim: {
      processId: TELEGRAM_SPOOLED_UPDATE_PROCESS_ID,
      processPid: process.pid,
      claimedAt: Date.now(),
    },
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== "ESRCH";
  }
}

function isFreshClaimOwner(claim: TelegramSpooledUpdateClaimOwner): boolean {
  return Date.now() - claim.claimedAt < TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS;
}

export function isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
  claim: ClaimedTelegramSpooledUpdate,
): boolean {
  return Boolean(
    claim.claim &&
    claim.claim.processId !== TELEGRAM_SPOOLED_UPDATE_PROCESS_ID &&
    isFreshClaimOwner(claim.claim) &&
    processExists(claim.claim.processPid),
  );
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
  const claimedPath = processingPath(params.spoolDir, updateId);
  if (await pathExists(claimedPath)) {
    return updateId;
  }
  const tempPath = path.join(params.spoolDir, `${spoolFileName(updateId)}.${randomUUID()}.tmp`);
  const payload: TelegramSpooledUpdatePayload = {
    version: SPOOL_VERSION,
    updateId,
    receivedAt: params.now ?? Date.now(),
    update: params.update,
  };
  await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  if (await pathExists(claimedPath)) {
    await unlinkIfPresent(tempPath);
    return updateId;
  }
  await fs.rename(tempPath, targetPath);
  return updateId;
}

export async function listTelegramSpooledUpdates(params: {
  spoolDir: string;
  limit?: number | "all";
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
  const files = entries.filter((entry) => entry.endsWith(".json")).toSorted();
  const limitedFiles =
    params.limit === "all" ? files : files.slice(0, Math.max(1, params.limit ?? 100));
  const updates: TelegramSpooledUpdate[] = [];
  for (const file of limitedFiles) {
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
  await unlinkIfPresent(update.path);
  if ("pendingPath" in update && typeof update.pendingPath === "string") {
    await unlinkIfPresent(update.pendingPath);
  }
}

export async function claimTelegramSpooledUpdate(
  update: TelegramSpooledUpdate,
): Promise<ClaimedTelegramSpooledUpdate | null> {
  const claimedPath = processingPath(path.dirname(update.path), update.updateId);
  const holdPath = path.join(
    path.dirname(update.path),
    `${spoolFileName(update.updateId)}.${randomUUID()}.claim`,
  );
  const tempPath = path.join(
    path.dirname(update.path),
    `${processingFileName(update.updateId)}.${randomUUID()}.tmp`,
  );
  try {
    const claimedAt = new Date();
    await fs.writeFile(tempPath, `${JSON.stringify(buildClaimedPayload(update))}\n`, {
      mode: 0o600,
    });
    await fs.link(update.path, holdPath);
    await fs.link(tempPath, claimedPath);
    await unlinkIfPresent(tempPath);
    await unlinkIfPresent(holdPath);
    await fs.utimes(claimedPath, claimedAt, claimedAt);
    await unlinkIfPresent(update.path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    await unlinkIfPresent(tempPath);
    await unlinkIfPresent(holdPath);
    if (code === "ENOENT" || code === "EEXIST") {
      return null;
    }
    throw err;
  }
  return {
    ...update,
    path: claimedPath,
    pendingPath: update.path,
  };
}

export async function releaseTelegramSpooledUpdateClaim(
  update: ClaimedTelegramSpooledUpdate,
): Promise<void> {
  try {
    await fs.rename(update.path, update.pendingPath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return;
    }
    if (code === "EEXIST") {
      await unlinkIfPresent(update.path);
      return;
    }
    throw err;
  }
}

export async function listTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
}): Promise<ClaimedTelegramSpooledUpdate[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(params.spoolDir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const claims: ClaimedTelegramSpooledUpdate[] = [];
  for (const file of entries.filter(isProcessingFileName).toSorted()) {
    const filePath = path.join(params.spoolDir, file);
    const { value } = await readJsonFileWithFallback<unknown>(filePath, null);
    const parsed = parseSpooledUpdate(value, filePath);
    if (parsed) {
      claims.push({
        ...parsed,
        pendingPath: path.join(params.spoolDir, pendingFileNameFromProcessing(file)),
      });
    }
  }
  return claims;
}

export async function recoverStaleTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
  staleMs?: number;
  now?: number;
  shouldRecover?: (claim: ClaimedTelegramSpooledUpdate) => boolean | Promise<boolean>;
}): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(params.spoolDir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return 0;
    }
    throw err;
  }
  const staleMs = Math.max(
    0,
    Math.floor(params.staleMs ?? TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS),
  );
  const now = params.now ?? Date.now();
  let recovered = 0;
  for (const entry of entries.filter(isProcessingFileName).toSorted()) {
    const claimedPath = path.join(params.spoolDir, entry);
    let stat;
    try {
      stat = await fs.stat(claimedPath);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        continue;
      }
      throw err;
    }
    if (now - stat.mtimeMs < staleMs) {
      continue;
    }
    const pendingPath = path.join(params.spoolDir, pendingFileNameFromProcessing(entry));
    if (params.shouldRecover) {
      const { value } = await readJsonFileWithFallback<unknown>(claimedPath, null);
      const parsed = parseSpooledUpdate(value, claimedPath);
      if (
        parsed &&
        !(await params.shouldRecover({
          ...parsed,
          pendingPath,
        }))
      ) {
        continue;
      }
    }
    if (await pathExists(pendingPath)) {
      await unlinkIfPresent(claimedPath);
    } else {
      await fs.rename(claimedPath, pendingPath);
    }
    recovered += 1;
  }
  return recovered;
}
