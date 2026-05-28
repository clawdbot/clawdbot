import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import { isJsonObject, type JsonValue } from "./protocol.js";
import { clearCodexAppServerBinding, type CodexAppServerThreadBinding } from "./session-binding.js";

// Codex owns proactive auto-compaction and derives its limit from the active model context
// window. OpenClaw only clears a bound native thread as a recovery fuse when Codex does
// not report that window, so the fallback stays well above normal compaction pressure.
const CODEX_APP_SERVER_NATIVE_THREAD_FALLBACK_MAX_TOKENS = 300_000;
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
  const sessionsFile = path.join(path.dirname(sessionFile), "sessions.json");
  let store: JsonValue | undefined;
  try {
    store = JSON.parse(await fs.readFile(sessionsFile, "utf8")) as JsonValue;
  } catch {
    return undefined;
  }
  if (!isJsonObject(store)) {
    return undefined;
  }
  const resolvedSessionFile = path.resolve(sessionFile);
  for (const [sessionKey, record] of Object.entries(store)) {
    if (!isJsonObject(record) || typeof record.sessionFile !== "string") {
      continue;
    }
    if (path.resolve(record.sessionFile) !== resolvedSessionFile) {
      continue;
    }
    return { sessionKey, ...record };
  }
  return undefined;
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

function resolveCodexAppServerNativeThreadTokenFuse(
  modelContextWindow: number | undefined,
): number {
  return modelContextWindow ?? CODEX_APP_SERVER_NATIVE_THREAD_FALLBACK_MAX_TOKENS;
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

function hasContextEngineThreadBootstrapProjection(binding: CodexAppServerThreadBinding): boolean {
  return binding.contextEngine?.projection?.mode === "thread_bootstrap";
}

export async function rotateOversizedCodexAppServerStartupBinding(params: {
  binding: CodexAppServerThreadBinding | undefined;
  sessionFile: string;
  agentDir: string;
  codexHome?: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  contextEngineActive?: boolean;
}): Promise<CodexAppServerThreadBinding | undefined> {
  const binding = params.binding;
  if (!binding?.threadId) {
    return binding;
  }
  if (params.config?.agents?.defaults?.compaction?.truncateAfterCompaction !== true) {
    return binding;
  }
  if (params.contextEngineActive === true && hasContextEngineThreadBootstrapProjection(binding)) {
    embeddedAgentLog.debug(
      "codex app-server deferring native transcript size guard for context-engine thread bootstrap",
      {
        threadId: binding.threadId,
        engineId: binding.contextEngine?.engineId,
        epoch: binding.contextEngine?.projection?.epoch,
        fingerprint: binding.contextEngine?.projection?.fingerprint,
      },
    );
    return binding;
  }
  const sessionRecord = await readCodexSessionRecordForSessionFile(params.sessionFile);
  const maxBytes = parseCodexAppServerByteLimit(
    params.config?.agents?.defaults?.compaction?.maxActiveTranscriptBytes,
  );
  const rolloutFiles = await listCodexAppServerRolloutFilesForThread(
    params.agentDir,
    binding.threadId,
    params.codexHome,
  );
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
      await clearCodexAppServerBinding(params.sessionFile);
      return undefined;
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
  const maxTokens = resolveCodexAppServerNativeThreadTokenFuse(nativeModelContextWindow);
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
      },
    );
    await clearCodexAppServerBinding(params.sessionFile);
    return undefined;
  }
  return binding;
}

export const testing = {
  parseCodexAppServerByteLimit,
  readCodexAppServerRolloutTokenSnapshotLine,
  resolveCodexAppServerNativeThreadTokenFuse,
};
