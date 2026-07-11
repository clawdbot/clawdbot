/**
 * Guards Codex app-server thread reuse during startup by rotating bindings when
 * native transcripts exceed byte or token budgets.
 */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { parseSqliteSessionFileMarker } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import { isJsonObject, type JsonValue } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./session-binding.js";

// Codex owns proactive auto-compaction, but OpenClaw must not resume a native
// thread that is already too close to the server-side window for the next turn.
const CODEX_APP_SERVER_NATIVE_THREAD_FALLBACK_MAX_TOKENS = 300_000;
const CODEX_APP_SERVER_NATIVE_THREAD_DEFAULT_RESERVE_TOKENS = 20_000;
const CODEX_APP_SERVER_NATIVE_THREAD_MIN_PROMPT_BUDGET_TOKENS = 8_000;
const CODEX_APP_SERVER_NATIVE_THREAD_MIN_PROMPT_BUDGET_RATIO = 0.5;
const CODEX_APP_SERVER_BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
  t: 1024 * 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  tib: 1024 * 1024 * 1024 * 1024,
};
type CodexSessionRecordCacheEntry = {
  sessionsFile: string;
  mtimeMs: number;
  size: number;
  record: (Record<string, unknown> & { sessionKey: string }) | undefined;
};

const codexSessionRecordCache = new Map<string, CodexSessionRecordCacheEntry>();

function parseCodexAppServerByteLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = CODEX_APP_SERVER_BYTE_UNITS[unit];
  if (multiplier === undefined) {
    return undefined;
  }
  return Math.max(1, Math.round(amount * multiplier));
}

async function listCodexAppServerRolloutFilesForThread(
  agentDir: string,
  threadId: string,
  codexHome?: string,
): Promise<Array<{ path: string; bytes: number }>> {
  const resolvedAgentDir = path.resolve(agentDir);
  const resolvedCodexHome = codexHome?.trim()
    ? path.resolve(codexHome)
    : resolveCodexAppServerHomeDir(resolvedAgentDir);
  const roots = [
    path.join(resolvedCodexHome, "sessions"),
    path.join(resolveCodexAppServerHomeDir(resolvedAgentDir), "sessions"),
    path.join(resolvedAgentDir, "agent", "codex-home", "sessions"),
    path.join(path.dirname(resolvedAgentDir), "codex-home", "sessions"),
  ];
  const files: Array<{ path: string; bytes: number }> = [];
  const visited = new Set<string>();
  for (const root of roots) {
    if (visited.has(root)) {
      continue;
    }
    visited.add(root);
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) {
        continue;
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(file);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) {
          continue;
        }
        try {
          files.push({ path: file, bytes: (await fs.stat(file)).size });
        } catch {
          // Ignore rollout files that disappeared while the guard was scanning.
        }
      }
    }
  }
  return files;
}

async function readCodexSessionRecordForSessionFile(
  sessionFile: string,
): Promise<(Record<string, unknown> & { sessionKey: string }) | undefined> {
  if (isSqliteSessionFileMarker(sessionFile)) {
    return undefined;
  }
  const sessionsFile = path.join(path.dirname(sessionFile), "sessions.json");
  const resolvedSessionFile = path.resolve(sessionFile);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(sessionsFile);
  } catch {
    codexSessionRecordCache.delete(resolvedSessionFile);
    return undefined;
  }
  const cached = codexSessionRecordCache.get(resolvedSessionFile);
  if (
    cached?.sessionsFile === sessionsFile &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.record;
  }
  let store: JsonValue | undefined;
  try {
    store = JSON.parse(await fs.readFile(sessionsFile, "utf8")) as JsonValue;
  } catch {
    codexSessionRecordCache.delete(resolvedSessionFile);
    return undefined;
  }
  if (!isJsonObject(store)) {
    codexSessionRecordCache.delete(resolvedSessionFile);
    return undefined;
  }
  let found: (Record<string, unknown> & { sessionKey: string }) | undefined;
  for (const [sessionKey, record] of Object.entries(store)) {
    if (!isJsonObject(record) || typeof record.sessionFile !== "string") {
      continue;
    }
    if (path.resolve(record.sessionFile) !== resolvedSessionFile) {
      continue;
    }
    found = { sessionKey, ...record };
    break;
  }
  codexSessionRecordCache.set(resolvedSessionFile, {
    sessionsFile,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    record: found,
  });
  return found;
}

function isSqliteSessionFileMarker(sessionFile: string | undefined): boolean {
  return parseSqliteSessionFileMarker(sessionFile) !== undefined;
}

type CodexAppServerRolloutTokenSnapshot = {
  totalTokens?: number;
  modelContextWindow?: number;
};

async function readCodexAppServerRolloutTokenSnapshot(
  file: string,
): Promise<CodexAppServerRolloutTokenSnapshot | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return undefined;
  }
  let snapshot: CodexAppServerRolloutTokenSnapshot | undefined;
  try {
    for await (const line of handle.readLines()) {
      const lineSnapshot = readCodexAppServerRolloutTokenSnapshotLine(line);
      if (lineSnapshot !== undefined) {
        snapshot ??= {};
        if (lineSnapshot.totalTokens !== undefined) {
          snapshot.totalTokens = lineSnapshot.totalTokens;
        }
        if (lineSnapshot.modelContextWindow !== undefined) {
          snapshot.modelContextWindow = lineSnapshot.modelContextWindow;
        }
      }
    }
  } finally {
    await handle.close();
  }
  return snapshot;
}

function readCodexAppServerRolloutTokenSnapshotLine(
  line: string,
): CodexAppServerRolloutTokenSnapshot | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as JsonValue;
    const payload = isJsonObject(parsed) ? parsed.payload : undefined;
    const info =
      isJsonObject(payload) && payload.type === "token_count" && isJsonObject(payload.info)
        ? payload.info
        : undefined;
    if (!info) {
      return undefined;
    }
    const usage = isJsonObject(info.last_token_usage)
      ? info.last_token_usage
      : isJsonObject(info.total_token_usage)
        ? info.total_token_usage
        : undefined;
    const value = usage?.total_tokens ?? usage?.totalTokens;
    const totalTokens = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const windowValue = info.model_context_window ?? info.modelContextWindow;
    const modelContextWindow =
      typeof windowValue === "number" && Number.isFinite(windowValue) && windowValue > 0
        ? Math.floor(windowValue)
        : undefined;
    const snapshot: CodexAppServerRolloutTokenSnapshot = {};
    if (totalTokens !== undefined) {
      snapshot.totalTokens = totalTokens;
    }
    if (modelContextWindow !== undefined) {
      snapshot.modelContextWindow = modelContextWindow;
    }
    return snapshot.totalTokens !== undefined || snapshot.modelContextWindow !== undefined
      ? snapshot
      : undefined;
  } catch {
    return undefined;
  }
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function readCompactionConfig(config: EmbeddedRunAttemptParams["config"] | undefined) {
  return isJsonObject(config?.agents?.defaults?.compaction)
    ? config.agents.defaults.compaction
    : undefined;
}

function resolveCodexAppServerNativeThreadReserveTokens(
  config: EmbeddedRunAttemptParams["config"] | undefined,
): number {
  const compaction = readCompactionConfig(config);
  const reserveTokens = toNonNegativeInt(compaction?.reserveTokens);
  const reserveTokensFloor = toNonNegativeInt(compaction?.reserveTokensFloor);
  if (reserveTokens !== undefined) {
    return Math.max(
      reserveTokens,
      reserveTokensFloor ?? CODEX_APP_SERVER_NATIVE_THREAD_DEFAULT_RESERVE_TOKENS,
    );
  }
  return reserveTokensFloor ?? CODEX_APP_SERVER_NATIVE_THREAD_DEFAULT_RESERVE_TOKENS;
}

function resolveCodexAppServerNativeThreadTokenFuse(params: {
  modelContextWindow: number | undefined;
  reserveTokens: number;
  projectedTurnTokens?: number;
}): number {
  const projectedTurnTokens =
    typeof params.projectedTurnTokens === "number" &&
    Number.isFinite(params.projectedTurnTokens) &&
    params.projectedTurnTokens > 0
      ? Math.floor(params.projectedTurnTokens)
      : 0;
  const contextWindow =
    params.modelContextWindow ?? CODEX_APP_SERVER_NATIVE_THREAD_FALLBACK_MAX_TOKENS;
  const minPromptBudget = Math.min(
    CODEX_APP_SERVER_NATIVE_THREAD_MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextWindow * CODEX_APP_SERVER_NATIVE_THREAD_MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    params.reserveTokens,
    Math.max(0, contextWindow - minPromptBudget),
  );
  return Math.max(1, contextWindow - effectiveReserveTokens - projectedTurnTokens);
}

function maxFiniteNumber(values: Array<number | undefined>): number | undefined {
  const nums = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (nums.length === 0) {
    return undefined;
  }
  return Math.max(...nums);
}

function minFiniteNumber(values: Array<number | undefined>): number | undefined {
  const nums = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (nums.length === 0) {
    return undefined;
  }
  return Math.min(...nums);
}

function hasContextEngineThreadBootstrapProjection(binding: CodexAppServerThreadBinding): boolean {
  return binding.contextEngine?.projection?.mode === "thread_bootstrap";
}

/** Clears and drops a binding when the native Codex thread is too large to resume safely. */
export async function rotateOversizedCodexAppServerStartupBinding(params: {
  binding: CodexAppServerThreadBinding | undefined;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  sessionFile: string;
  agentDir: string;
  codexHome?: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  contextEngineActive?: boolean;
  projectedTurnTokens?: number;
}): Promise<CodexAppServerThreadBinding | undefined> {
  const binding = params.binding;
  if (!binding?.threadId) {
    return binding;
  }
  // Native Codex owns compaction for supervised threads. Clearing this private
  // scope marker would silently move the next turn back to the agent runtime.
  if (binding.connectionScope === "supervision") {
    return binding;
  }
  const sessionRecord = await readCodexSessionRecordForSessionFile(params.sessionFile);
  const rolloutFiles = await listCodexAppServerRolloutFilesForThread(
    params.agentDir,
    binding.threadId,
    params.codexHome,
  );
  const compaction = readCompactionConfig(params.config);
  const shouldDeferByteGuard =
    compaction?.truncateAfterCompaction === true &&
    params.contextEngineActive === true &&
    hasContextEngineThreadBootstrapProjection(binding);
  if (compaction?.truncateAfterCompaction === true && !shouldDeferByteGuard) {
    const maxBytes = parseCodexAppServerByteLimit(compaction.maxActiveTranscriptBytes);
    if (maxBytes !== undefined) {
      const oversizedFiles = rolloutFiles.filter((file) => file.bytes >= maxBytes);
      if (oversizedFiles.length > 0) {
        embeddedAgentLog.warn(
          "codex app-server native transcript exceeded active byte limit; starting a fresh thread",
          {
            threadId: binding.threadId,
            maxBytes,
            files: oversizedFiles.map((file) => ({ path: file.path, bytes: file.bytes })),
          },
        );
        await params.bindingStore.mutate(params.identity, {
          kind: "clear",
          threadId: binding.threadId,
        });
        return undefined;
      }
    }
  }
  const nativeTokenSnapshots = await Promise.all(
    rolloutFiles.map(async (file) => readCodexAppServerRolloutTokenSnapshot(file.path)),
  );
  const nativeTokens = maxFiniteNumber(
    nativeTokenSnapshots.map((snapshot) => snapshot?.totalTokens),
  );
  const nativeModelContextWindow = maxFiniteNumber(
    nativeTokenSnapshots.map((snapshot) => snapshot?.modelContextWindow),
  );
  const sessionModelContextWindow =
    typeof sessionRecord?.contextTokens === "number" &&
    Number.isFinite(sessionRecord.contextTokens) &&
    sessionRecord.contextTokens > 0
      ? Math.floor(sessionRecord.contextTokens)
      : undefined;
  const reserveTokens = resolveCodexAppServerNativeThreadReserveTokens(params.config);
  const maxTokens = resolveCodexAppServerNativeThreadTokenFuse({
    modelContextWindow: minFiniteNumber([nativeModelContextWindow, sessionModelContextWindow]),
    reserveTokens,
    projectedTurnTokens: params.projectedTurnTokens,
  });
  const sessionTokens =
    sessionRecord?.totalTokensFresh !== false &&
    typeof sessionRecord?.totalTokens === "number" &&
    Number.isFinite(sessionRecord.totalTokens)
      ? sessionRecord.totalTokens
      : undefined;
  const tokenCount = maxFiniteNumber([sessionTokens, nativeTokens]);
  if (tokenCount !== undefined && tokenCount >= maxTokens) {
    embeddedAgentLog.warn(
      "codex app-server native transcript exceeded active token limit; starting a fresh thread",
      {
        threadId: binding.threadId,
        maxTokens,
        sessionKey: sessionRecord?.sessionKey,
        sessionTokens,
        nativeTokens,
        nativeModelContextWindow,
        sessionModelContextWindow,
        reserveTokens,
        projectedTurnTokens: params.projectedTurnTokens,
      },
    );
    await params.bindingStore.mutate(params.identity, {
      kind: "clear",
      threadId: binding.threadId,
    });
    return undefined;
  }
  if (compaction?.truncateAfterCompaction !== true) {
    return binding;
  }
  if (shouldDeferByteGuard) {
    embeddedAgentLog.debug(
      "codex app-server deferring native transcript byte guard for context-engine thread bootstrap",
      {
        threadId: binding.threadId,
        engineId: binding.contextEngine?.engineId,
        epoch: binding.contextEngine?.projection?.epoch,
        fingerprint: binding.contextEngine?.projection?.fingerprint,
      },
    );
    return binding;
  }
  return binding;
}

/** Internal sizing helpers exposed for startup-binding regression tests. */
export const testing = {
  parseCodexAppServerByteLimit,
  readCodexAppServerRolloutTokenSnapshotLine,
  resolveCodexAppServerNativeThreadTokenFuse,
  resolveCodexAppServerNativeThreadReserveTokens,
};
