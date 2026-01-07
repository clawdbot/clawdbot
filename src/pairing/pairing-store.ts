import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";

import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
const PAIRING_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export type PairingProvider =
  | "telegram"
  | "signal"
  | "imessage"
  | "discord"
  | "slack"
  | "matrix"
  | "whatsapp";

export type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

type PairingStore = {
  version: 1;
  requests: PairingRequest[];
};

type AllowFromStore = {
  version: 1;
  allowFrom: string[];
};

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return resolveOAuthDir(env, stateDir);
}

function resolvePairingPath(
  provider: PairingProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveCredentialsDir(env), `${provider}-pairing.json`);
}

function resolveAllowFromPath(
  provider: PairingProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveCredentialsDir(env), `${provider}-allowFrom.json`);
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = safeParseJson<T>(raw);
    if (parsed == null) return { value: fallback, exists: true };
    return { value: parsed, exists: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return { value: fallback, exists: false };
    return { value: fallback, exists: false };
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

async function ensureJsonFile(filePath: string, fallback: unknown) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}

async function withFileLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, PAIRING_STORE_LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore unlock errors
      }
    }
  }
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  if (!createdAt) return true;
  return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}

function pruneExpiredRequests(reqs: PairingRequest[], nowMs: number) {
  const kept: PairingRequest[] = [];
  let removed = false;
  for (const req of reqs) {
    if (isExpired(req, nowMs)) {
      removed = true;
      continue;
    }
    kept.push(req);
  }
  return { requests: kept, removed };
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    out += PAIRING_CODE_ALPHABET[idx];
  }
  return out;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) return code;
  }
  throw new Error("failed to generate unique pairing code");
}

function normalizeId(value: string | number): string {
  return String(value).trim();
}

function normalizeAllowEntry(provider: PairingProvider, entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "";
  if (provider === "telegram") return trimmed.replace(/^(telegram|tg):/i, "");
  if (provider === "signal") return trimmed.replace(/^signal:/i, "");
  if (provider === "discord") return trimmed.replace(/^(discord|user):/i, "");
  if (provider === "slack") return trimmed.replace(/^(slack|user):/i, "");
  if (provider === "matrix") return trimmed.replace(/^(matrix|user):/i, "");
  return trimmed;
}

export async function readProviderAllowFromStore(
  provider: PairingProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const filePath = resolveAllowFromPath(provider, env);
  const { value } = await readJsonFile<AllowFromStore>(filePath, {
    version: 1,
    allowFrom: [],
  });
  const list = Array.isArray(value.allowFrom) ? value.allowFrom : [];
  return list
    .map((v) => normalizeAllowEntry(provider, String(v)))
    .filter(Boolean);
}

export async function addProviderAllowFromStoreEntry(params: {
  provider: PairingProvider;
  entry: string | number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  const env = params.env ?? process.env;
  const filePath = resolveAllowFromPath(params.provider, env);
  return await withFileLock(
    filePath,
    { version: 1, allowFrom: [] } satisfies AllowFromStore,
    async () => {
      const { value } = await readJsonFile<AllowFromStore>(filePath, {
        version: 1,
        allowFrom: [],
      });
      const current = (Array.isArray(value.allowFrom) ? value.allowFrom : [])
        .map((v) => normalizeAllowEntry(params.provider, String(v)))
        .filter(Boolean);
      const normalized = normalizeAllowEntry(
        params.provider,
        normalizeId(params.entry),
      );
      if (!normalized) return { changed: false, allowFrom: current };
      if (current.includes(normalized))
        return { changed: false, allowFrom: current };
      const next = [...current, normalized];
      await writeJsonFile(filePath, {
        version: 1,
        allowFrom: next,
      } satisfies AllowFromStore);
      return { changed: true, allowFrom: next };
    },
  );
}

export async function listProviderPairingRequests(
  provider: PairingProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PairingRequest[]> {
  const filePath = resolvePairingPath(provider, env);
  return await withFileLock(
    filePath,
    { version: 1, requests: [] } satisfies PairingStore,
    async () => {
      const { value } = await readJsonFile<PairingStore>(filePath, {
        version: 1,
        requests: [],
      });
      const reqs = Array.isArray(value.requests) ? value.requests : [];
      const nowMs = Date.now();
      const { requests: pruned, removed } = pruneExpiredRequests(reqs, nowMs);
      if (removed) {
        await writeJsonFile(filePath, {
          version: 1,
          requests: pruned,
        } satisfies PairingStore);
      }
      return pruned
        .filter(
          (r) =>
            r &&
            typeof r.id === "string" &&
            typeof r.code === "string" &&
            typeof r.createdAt === "string",
        )
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  );
}

export async function upsertProviderPairingRequest(params: {
  provider: PairingProvider;
  id: string | number;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  const filePath = resolvePairingPath(params.provider, env);
  return await withFileLock(
    filePath,
    { version: 1, requests: [] } satisfies PairingStore,
    async () => {
      const { value } = await readJsonFile<PairingStore>(filePath, {
        version: 1,
        requests: [],
      });
      const now = new Date().toISOString();
      const nowMs = Date.now();
      const id = normalizeId(params.id);
      const meta =
        params.meta && typeof params.meta === "object"
          ? Object.fromEntries(
              Object.entries(params.meta)
                .map(([k, v]) => [k, String(v ?? "").trim()] as const)
                .filter(([_, v]) => Boolean(v)),
            )
          : undefined;

      let reqs = Array.isArray(value.requests) ? value.requests : [];
      const { requests: pruned } = pruneExpiredRequests(reqs, nowMs);
      reqs = pruned;
      const existingIdx = reqs.findIndex((r) => r.id === id);
      const existingCodes = new Set(
        reqs.map((req) =>
          String(req.code ?? "")
            .trim()
            .toUpperCase(),
        ),
      );

      if (existingIdx >= 0) {
        const existing = reqs[existingIdx];
        const existingCode =
          existing && typeof existing.code === "string"
            ? existing.code.trim()
            : "";
        const code = existingCode || generateUniqueCode(existingCodes);
        const next: PairingRequest = {
          id,
          code,
          createdAt: existing?.createdAt ?? now,
          lastSeenAt: now,
          meta: meta ?? existing?.meta,
        };
        reqs[existingIdx] = next;
        await writeJsonFile(filePath, {
          version: 1,
          requests: reqs,
        } satisfies PairingStore);
        return { code, created: false };
      }

      const code = generateUniqueCode(existingCodes);
      const next: PairingRequest = {
        id,
        code,
        createdAt: now,
        lastSeenAt: now,
        ...(meta ? { meta } : {}),
      };
      await writeJsonFile(filePath, {
        version: 1,
        requests: [...reqs, next],
      } satisfies PairingStore);
      return { code, created: true };
    },
  );
}

export async function approveProviderPairingCode(params: {
  provider: PairingProvider;
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry?: PairingRequest } | null> {
  const env = params.env ?? process.env;
  const code = params.code.trim().toUpperCase();
  if (!code) return null;

  const filePath = resolvePairingPath(params.provider, env);
  return await withFileLock(
    filePath,
    { version: 1, requests: [] } satisfies PairingStore,
    async () => {
      const { value } = await readJsonFile<PairingStore>(filePath, {
        version: 1,
        requests: [],
      });
      const reqs = Array.isArray(value.requests) ? value.requests : [];
      const nowMs = Date.now();
      const { requests: pruned, removed } = pruneExpiredRequests(reqs, nowMs);
      const idx = pruned.findIndex(
        (r) => String(r.code ?? "").toUpperCase() === code,
      );
      if (idx < 0) {
        if (removed) {
          await writeJsonFile(filePath, {
            version: 1,
            requests: pruned,
          } satisfies PairingStore);
        }
        return null;
      }
      const entry = pruned[idx];
      if (!entry) return null;
      pruned.splice(idx, 1);
      await writeJsonFile(filePath, {
        version: 1,
        requests: pruned,
      } satisfies PairingStore);
      await addProviderAllowFromStoreEntry({
        provider: params.provider,
        entry: entry.id,
        env,
      });
      return { id: entry.id, entry };
    },
  );
}
