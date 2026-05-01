import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { readStringValue } from "../shared/string-coerce.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

const REGISTRY_VERSION = 2 as const;
const MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES = 32;

type PersistedSubagentRunRecord = SubagentRunRecord;

type RegistryCacheEntry = {
  signature: string;
  runs: Map<string, SubagentRunRecord>;
};

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

const registryReadCache = new Map<string, RegistryCacheEntry>();

function cloneSubagentRunRecord(entry: SubagentRunRecord): SubagentRunRecord {
  return structuredClone(entry);
}

function cloneSubagentRunMap(runs: Map<string, SubagentRunRecord>): Map<string, SubagentRunRecord> {
  return new Map([...runs].map(([runId, entry]) => [runId, cloneSubagentRunRecord(entry)]));
}

function setCachedRegistryRead(
  pathname: string,
  signature: string,
  runs: Map<string, SubagentRunRecord>,
): void {
  registryReadCache.delete(pathname);
  registryReadCache.set(pathname, { signature, runs: cloneSubagentRunMap(runs) });
  if (registryReadCache.size <= MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES) {
    return;
  }
  const oldestKey = registryReadCache.keys().next().value;
  if (typeof oldestKey === "string") {
    registryReadCache.delete(oldestKey);
  }
}

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveSubagentRegistryPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const pathname = resolveSubagentRegistryPath();
  const signature = statRegistryFileSignature(pathname);
  if (signature === null) {
    registryReadCache.delete(pathname);
    return new Map();
  }
  const cached = registryReadCache.get(pathname);
  if (cached?.signature === signature) {
    registryReadCache.delete(pathname);
    registryReadCache.set(pathname, cached);
    return cloneSubagentRunMap(cached.runs);
  }
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    setCachedRegistryRead(pathname, signature, new Map());
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    setCachedRegistryRead(pathname, signature, new Map());
    return new Map();
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    setCachedRegistryRead(pathname, signature, new Map());
    return new Map();
  }
  const out = new Map<string, SubagentRunRecord>();
  const isLegacy = record.version === 1;
  let migrated = false;
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const cleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: readStringValue(typed.requesterChannel),
        accountId: readStringValue(typed.requesterAccountId),
      },
    );
    const childSessionKey = readStringValue(typed.childSessionKey)?.trim() ?? "";
    const requesterSessionKey = readStringValue(typed.requesterSessionKey)?.trim() ?? "";
    const controllerSessionKey =
      readStringValue(typed.controllerSessionKey)?.trim() || requesterSessionKey;
    if (!childSessionKey || !requesterSessionKey) {
      continue;
    }
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(runId, {
      ...rest,
      childSessionKey,
      requesterSessionKey,
      controllerSessionKey,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
      spawnMode: typed.spawnMode === "session" ? "session" : "run",
    });
    if (isLegacy) {
      migrated = true;
    }
  }
  if (migrated) {
    try {
      saveSubagentRegistryToDisk(out);
    } catch {
      // ignore migration write failures
    }
  } else {
    setCachedRegistryRead(pathname, signature, out);
  }
  return out;
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  const pathname = resolveSubagentRegistryPath();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  saveJsonFile(pathname, out);
  const signature = statRegistryFileSignature(pathname);
  if (signature === null) {
    registryReadCache.delete(pathname);
  } else {
    setCachedRegistryRead(pathname, signature, runs);
  }
}

function statRegistryFileSignature(pathname: string): string | null {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    if (!stat.isFile()) {
      return null;
    }
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
