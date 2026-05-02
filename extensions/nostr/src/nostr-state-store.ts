import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeParseJsonWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import { getNostrRuntime } from "./runtime.js";

const STORE_VERSION = 2;
const PROFILE_STATE_VERSION = 1;

type _NostrBusStateV1 = {
  version: 1;
  /** Unix timestamp (seconds) of the last processed event */
  lastProcessedAt: number | null;
  /** Gateway startup timestamp (seconds) - events before this are old */
  gatewayStartedAt: number | null;
};

type NostrBusState = {
  version: 2;
  /** Unix timestamp (seconds) of the last processed event */
  lastProcessedAt: number | null;
  /** Gateway startup timestamp (seconds) - events before this are old */
  gatewayStartedAt: number | null;
  /** Recent processed event IDs for overlap dedupe across restarts */
  recentEventIds: string[];
};

/** Profile publish state (separate from bus state) */
type NostrProfileState = {
  version: 1;
  /** Unix timestamp (seconds) of last successful profile publish */
  lastPublishedAt: number | null;
  /** Event ID of the last published profile */
  lastPublishedEventId: string | null;
  /** Per-relay publish results from last attempt */
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
};

const NullableFiniteNumberSchema = z.number().finite().nullable().catch(null);
const NostrBusStateV1Schema = z.object({
  version: z.literal(1),
  lastProcessedAt: NullableFiniteNumberSchema,
  gatewayStartedAt: NullableFiniteNumberSchema,
});

const NostrBusStateSchema = z.object({
  version: z.literal(2),
  lastProcessedAt: NullableFiniteNumberSchema,
  gatewayStartedAt: NullableFiniteNumberSchema,
  recentEventIds: z
    .array(z.unknown())
    .catch([])
    .transform((ids) => ids.filter((id): id is string => typeof id === "string")),
});

const NostrProfileStateSchema = z.object({
  version: z.literal(1),
  lastPublishedAt: NullableFiniteNumberSchema,
  lastPublishedEventId: z.string().nullable().catch(null),
  lastPublishResults: z
    .record(z.string(), z.enum(["ok", "failed", "timeout"]))
    .nullable()
    .catch(null),
});

function normalizeAccountId(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveNostrStatePath(accountId?: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "nostr", `bus-state-${normalized}.json`);
}

function resolveNostrProfileStatePath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "nostr", `profile-state-${normalized}.json`);
}

function safeParseState(raw: string): NostrBusState | null {
  const parsedV2 = safeParseJsonWithSchema(NostrBusStateSchema, raw);
  if (parsedV2) {
    return parsedV2;
  }

  const parsedV1 = safeParseJsonWithSchema(NostrBusStateV1Schema, raw);
  if (!parsedV1) {
    return null;
  }

  // Back-compat: v1 state files
  return {
    version: 2,
    lastProcessedAt: parsedV1.lastProcessedAt,
    gatewayStartedAt: parsedV1.gatewayStartedAt,
    recentEventIds: [],
  };
}

export async function readNostrBusState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrBusState | null> {
  const filePath = resolveNostrStatePath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseState(raw);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeNostrBusState(params: {
  accountId?: string;
  lastProcessedAt: number;
  gatewayStartedAt: number;
  recentEventIds?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveNostrStatePath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload: NostrBusState = {
    version: STORE_VERSION,
    lastProcessedAt: params.lastProcessedAt,
    gatewayStartedAt: params.gatewayStartedAt,
    recentEventIds: (params.recentEventIds ?? []).filter((x): x is string => typeof x === "string"),
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

/**
 * Determine the `since` timestamp for subscription.
 * Returns the later of: lastProcessedAt or gatewayStartedAt (both from disk),
 * falling back to `now` for fresh starts.
 */
export function computeSinceTimestamp(
  state: NostrBusState | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (!state) {
    return nowSec;
  }

  // Use the most recent timestamp we have
  const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter(
    (t): t is number => t !== null && t > 0,
  );

  if (candidates.length === 0) {
    return nowSec;
  }
  return Math.max(...candidates);
}

// ============================================================================
// Profile State Management
// ============================================================================

function safeParseProfileState(raw: string): NostrProfileState | null {
  return safeParseJsonWithSchema(NostrProfileStateSchema, raw);
}

export async function readNostrProfileState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrProfileState | null> {
  const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseProfileState(raw);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeNostrProfileState(params: {
  accountId?: string;
  lastPublishedAt: number;
  lastPublishedEventId: string;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload: NostrProfileState = {
    version: PROFILE_STATE_VERSION,
    lastPublishedAt: params.lastPublishedAt,
    lastPublishedEventId: params.lastPublishedEventId,
    lastPublishResults: params.lastPublishResults,
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}
