import crypto from "node:crypto";
import type { NormalizedUsage } from "../usage.js";

export type PromptCacheChangeCode =
  | "cacheRetention"
  | "model"
  | "streamStrategy"
  | "systemPrompt"
  | "tools"
  | "transport";

export type PromptCacheChange = {
  code: PromptCacheChangeCode;
  detail: string;
};

export type PromptCacheSnapshot = {
  provider: string;
  modelId: string;
  modelApi?: string | null;
  cacheRetention?: "none" | "short" | "long";
  streamStrategy: string;
  transport?: string;
  systemPromptDigest: string;
  toolDigest: string;
  toolCount: number;
  toolNames: string[];
};

export type PromptCacheObservationStart = {
  snapshot: PromptCacheSnapshot;
  changes: PromptCacheChange[] | null;
  previousCacheRead: number | null;
};

export type PromptCacheBreak = {
  previousCacheRead: number;
  cacheRead: number;
  changes: PromptCacheChange[] | null;
};

type PromptCacheTracker = {
  snapshot: PromptCacheSnapshot;
  lastCacheRead: number | null;
  pendingChanges: PromptCacheChange[] | null;
};

const trackers = new Map<string, PromptCacheTracker>();
const MAX_TRACKERS = 512;

const MIN_CACHE_BREAK_TOKEN_DROP = 1_000;
const MAX_STABLE_CACHE_READ_RATIO = 0.95;

function digestText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildTrackerKey(params: {
  promptCacheKey?: string;
  sessionKey?: string;
  sessionId: string;
}): string {
  const promptCacheKey = params.promptCacheKey?.trim();
  if (promptCacheKey) {
    return promptCacheKey;
  }
  return params.sessionKey?.trim() || params.sessionId;
}

function buildToolDigest(toolNames: string[]): string {
  // Treat diagnostics as set-stable here: order changes alone should not look
  // like a real cache break when the same tool set is still present.
  return digestText(JSON.stringify([...toolNames].toSorted()));
}

function setTracker(key: string, tracker: PromptCacheTracker): void {
  if (trackers.has(key)) {
    trackers.delete(key);
  } else if (trackers.size >= MAX_TRACKERS) {
    const oldestKey = trackers.keys().next().value;
    if (typeof oldestKey === "string") {
      trackers.delete(oldestKey);
    }
  }
  trackers.set(key, tracker);
}

function diffSnapshots(
  previous: PromptCacheSnapshot,
  next: PromptCacheSnapshot,
): PromptCacheChange[] | null {
  const changes: PromptCacheChange[] = [];
  if (previous.provider !== next.provider || previous.modelId !== next.modelId) {
    changes.push({
      code: "model",
      detail: `${previous.provider}/${previous.modelId} -> ${next.provider}/${next.modelId}`,
    });
  } else if ((previous.modelApi ?? null) !== (next.modelApi ?? null)) {
    changes.push({
      code: "model",
      detail: `${previous.modelApi ?? "unknown"} -> ${next.modelApi ?? "unknown"}`,
    });
  }
  if (previous.cacheRetention !== next.cacheRetention) {
    changes.push({
      code: "cacheRetention",
      detail: `${previous.cacheRetention ?? "default"} -> ${next.cacheRetention ?? "default"}`,
    });
  }
  if (previous.transport !== next.transport) {
    changes.push({
      code: "transport",
      detail: `${previous.transport ?? "default"} -> ${next.transport ?? "default"}`,
    });
  }
  if (previous.streamStrategy !== next.streamStrategy) {
    changes.push({
      code: "streamStrategy",
      detail: `${previous.streamStrategy} -> ${next.streamStrategy}`,
    });
  }
  if (previous.systemPromptDigest !== next.systemPromptDigest) {
    changes.push({
      code: "systemPrompt",
      detail: "system prompt digest changed",
    });
  }
  if (previous.toolDigest !== next.toolDigest) {
    changes.push({
      code: "tools",
      detail:
        previous.toolCount === next.toolCount
          ? "tool set changed with same count"
          : `${previous.toolCount} -> ${next.toolCount} tools`,
    });
  }
  return changes.length > 0 ? changes : null;
}

export function collectPromptCacheToolNames(tools: Array<{ name?: string }>): string[] {
  return tools.map((tool) => tool.name?.trim()).filter((name): name is string => Boolean(name));
}

export function beginPromptCacheObservation(params: {
  sessionId: string;
  promptCacheKey?: string;
  sessionKey?: string;
  provider: string;
  modelId: string;
  modelApi?: string | null;
  cacheRetention?: "none" | "short" | "long";
  streamStrategy: string;
  transport?: string;
  systemPrompt: string;
  toolNames: string[];
}): PromptCacheObservationStart {
  const key = buildTrackerKey(params);
  const snapshot: PromptCacheSnapshot = {
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    cacheRetention: params.cacheRetention,
    streamStrategy: params.streamStrategy,
    transport: params.transport,
    systemPromptDigest: digestText(params.systemPrompt),
    toolDigest: buildToolDigest(params.toolNames),
    toolCount: params.toolNames.length,
    toolNames: [...params.toolNames],
  };
  const previous = trackers.get(key);
  const changes = previous ? diffSnapshots(previous.snapshot, snapshot) : null;
  setTracker(key, {
    snapshot,
    lastCacheRead: previous?.lastCacheRead ?? null,
    pendingChanges: changes,
  });
  return {
    snapshot,
    changes,
    previousCacheRead: previous?.lastCacheRead ?? null,
  };
}

export function completePromptCacheObservation(params: {
  sessionId: string;
  promptCacheKey?: string;
  sessionKey?: string;
  usage?: NormalizedUsage;
}): PromptCacheBreak | null {
  const key = buildTrackerKey(params);
  const tracker = trackers.get(key);
  if (!tracker) {
    return null;
  }

  const cacheRead = params.usage?.cacheRead;
  if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead)) {
    tracker.pendingChanges = null;
    return null;
  }
  const previousCacheRead = tracker.lastCacheRead;
  tracker.lastCacheRead = cacheRead;

  if (previousCacheRead == null || previousCacheRead <= 0) {
    tracker.pendingChanges = null;
    return null;
  }

  const tokenDrop = previousCacheRead - cacheRead;
  const hasMeaningfulDrop =
    cacheRead < previousCacheRead * MAX_STABLE_CACHE_READ_RATIO &&
    tokenDrop >= MIN_CACHE_BREAK_TOKEN_DROP;
  const result = hasMeaningfulDrop
    ? {
        previousCacheRead,
        cacheRead,
        changes: tracker.pendingChanges,
      }
    : null;
  tracker.pendingChanges = null;
  return result;
}

export function resetPromptCacheObservabilityForTest(): void {
  trackers.clear();
}
