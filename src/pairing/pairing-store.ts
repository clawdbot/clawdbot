import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";

export type PairingProvider =
  | "telegram"
  | "signal"
  | "imessage"
  | "discord"
  | "slack"
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
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf-8",
  );
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
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
}

export async function listProviderPairingRequests(
  provider: PairingProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PairingRequest[]> {
  const filePath = resolvePairingPath(provider, env);
  const { value } = await readJsonFile<PairingStore>(filePath, {
    version: 1,
    requests: [],
  });
  const reqs = Array.isArray(value.requests) ? value.requests : [];
  return reqs
    .filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        typeof r.code === "string" &&
        typeof r.createdAt === "string",
    )
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function upsertProviderPairingRequest(params: {
  provider: PairingProvider;
  id: string | number;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  const filePath = resolvePairingPath(params.provider, env);
  const { value } = await readJsonFile<PairingStore>(filePath, {
    version: 1,
    requests: [],
  });
  const now = new Date().toISOString();
  const id = normalizeId(params.id);
  const meta =
    params.meta && typeof params.meta === "object"
      ? Object.fromEntries(
          Object.entries(params.meta)
            .map(([k, v]) => [k, String(v ?? "").trim()] as const)
            .filter(([_, v]) => Boolean(v)),
        )
      : undefined;

  const reqs = Array.isArray(value.requests) ? value.requests : [];
  const existingIdx = reqs.findIndex((r) => r.id === id);
  if (existingIdx >= 0) {
    const existing = reqs[existingIdx];
    const existingCode =
      existing && typeof existing.code === "string" ? existing.code.trim() : "";
    const code = existingCode || randomCode();
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

  const code = randomCode();
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
  const { value } = await readJsonFile<PairingStore>(filePath, {
    version: 1,
    requests: [],
  });
  const reqs = Array.isArray(value.requests) ? value.requests : [];
  const idx = reqs.findIndex(
    (r) => String(r.code ?? "").toUpperCase() === code,
  );
  if (idx < 0) return null;
  const entry = reqs[idx];
  if (!entry) return null;
  reqs.splice(idx, 1);
  await writeJsonFile(filePath, {
    version: 1,
    requests: reqs,
  } satisfies PairingStore);
  await addProviderAllowFromStoreEntry({
    provider: params.provider,
    entry: entry.id,
    env,
  });
  return { id: entry.id, entry };
}
