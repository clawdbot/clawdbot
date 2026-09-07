/**
 * Tracks prompt-cache snapshot changes for observability diagnostics.
 */
import crypto from "node:crypto";
import {
  sortPromptCacheToolsByName,
  splitSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { stableStringify } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { NormalizedUsage } from "../usage.js";

type PromptCacheChangeCode =
  | "aggregateToolResultTruncation"
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

type PromptCacheToolSnapshot = {
  name: string;
  descriptionDigest?: string;
  schemaDigest?: string;
};

type PromptCacheToolDescriptor = {
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: unknown;
};

type PromptCacheSnapshot = {
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

type PromptCacheObservationStart = {
  snapshot: PromptCacheSnapshot;
  changes: PromptCacheChange[] | null;
  previousCacheRead: number | null;
};

type PromptCacheBreak = {
  previousCacheRead: number;
  cacheRead: number;
  changes: PromptCacheChange[] | null;
};

type PromptCacheTracker = {
  snapshot: PromptCacheSnapshot;
  lastCacheRead: number | null;
  /** Missing usage must not bind an older hit to a new request fingerprint. */
  lastCacheReadSnapshot?: PromptCacheSnapshot;
  pendingChanges: PromptCacheChange[] | null;
};

const trackers = new Map<string, PromptCacheTracker>();
const MAX_TRACKERS = 512;
const MAX_TOOL_SCHEMA_FINGERPRINT_DEPTH = 24;
const MAX_TOOL_SCHEMA_FINGERPRINT_NODES = 2_048;
const MAX_TOOL_SCHEMA_FINGERPRINT_ENTRIES = 128;
const MAX_TOOL_SCHEMA_FINGERPRINT_STRING_CHARS = 4_096;

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

function normalizeToolSchemaFingerprint(
  value: unknown,
  state: { remainingNodes: number; stack: WeakSet<object> },
  depth = 0,
): unknown {
  if (depth >= MAX_TOOL_SCHEMA_FINGERPRINT_DEPTH || state.remainingNodes <= 0) {
    return "[schema fingerprint limit]";
  }
  state.remainingNodes -= 1;
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "[non-finite number]";
  }
  if (typeof value === "string") {
    return truncateUtf16Safe(value, MAX_TOOL_SCHEMA_FINGERPRINT_STRING_CHARS);
  }
  if (typeof value !== "object") {
    return `[${typeof value}]`;
  }
  if (state.stack.has(value)) {
    return "[circular schema]";
  }
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = value
        .slice(0, MAX_TOOL_SCHEMA_FINGERPRINT_ENTRIES)
        .map((entry) => normalizeToolSchemaFingerprint(entry, state, depth + 1));
      if (value.length > MAX_TOOL_SCHEMA_FINGERPRINT_ENTRIES) {
        entries.push({ omitted: value.length - MAX_TOOL_SCHEMA_FINGERPRINT_ENTRIES });
      }
      return entries;
    }
    const record = value as Record<string, unknown>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.hasOwn(record, key)) {
        continue;
      }
      // A schema above this limit receives one order-independent marker. Do
      // not materialize or sort an attacker-controlled complete key list.
      if (keys.length >= MAX_TOOL_SCHEMA_FINGERPRINT_ENTRIES) {
        return "[schema key limit]";
      }
      keys.push(key);
    }
    keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    // Schema property names are untrusted; a null prototype keeps "__proto__"
    // as an own fingerprinted key instead of invoking a prototype setter.
    const entries = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      try {
        entries[key] = normalizeToolSchemaFingerprint(record[key], state, depth + 1);
      } catch {
        entries[key] = "[unreadable schema value]";
      }
    }
    return entries;
  } catch {
    return "[unreadable schema]";
  } finally {
    state.stack.delete(value);
  }
}

function buildToolDigest(tools: readonly PromptCacheToolSnapshot[]): string {
  // Cache identity includes the exact visible descriptor, not just its name;
  // canonical ordering prevents discovery order from looking like a break.
  return digestText(stableStringify(sortPromptCacheToolsByName(tools)));
}

function setTracker(key: string, tracker: PromptCacheTracker): void {
  if (trackers.has(key)) {
    trackers.delete(key);
  } else if (trackers.size >= MAX_TRACKERS) {
    pruneMapToMaxSize(trackers, MAX_TRACKERS - 1);
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

export function collectPromptCacheTools(
  tools: readonly PromptCacheToolDescriptor[],
): PromptCacheToolSnapshot[] {
  const snapshots: PromptCacheToolSnapshot[] = [];
  for (const tool of tools) {
    try {
      const name = tool.name?.trim();
      if (!name) {
        continue;
      }
      const snapshot: PromptCacheToolSnapshot = { name };
      try {
        if (typeof tool.description === "string") {
          snapshot.descriptionDigest = digestText(tool.description);
        }
      } catch {
        snapshot.descriptionDigest = digestText("[unreadable tool description]");
      }
      try {
        if (tool.parameters !== undefined) {
          snapshot.schemaDigest = digestText(
            stableStringify(
              normalizeToolSchemaFingerprint(tool.parameters, {
                remainingNodes: MAX_TOOL_SCHEMA_FINGERPRINT_NODES,
                stack: new WeakSet(),
              }),
            ),
          );
        }
      } catch {
        snapshot.schemaDigest = digestText("[unreadable tool schema]");
      }
      snapshots.push(snapshot);
    } catch {
      continue;
    }
  }
  return sortPromptCacheToolsByName(snapshots);
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
  tools: readonly PromptCacheToolSnapshot[];
}): PromptCacheObservationStart {
  const key = buildTrackerKey(params);
  const tools = sortPromptCacheToolsByName(params.tools);
  const snapshot: PromptCacheSnapshot = {
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    cacheRetention: params.cacheRetention,
    streamStrategy: params.streamStrategy,
    transport: params.transport,
    systemPromptDigest: digestText(
      splitSystemPromptCacheBoundary(params.systemPrompt)?.stablePrefix ?? params.systemPrompt,
    ),
    toolDigest: buildToolDigest(tools),
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
  };
  const previous = trackers.get(key);
  const changes = previous
    ? [
        ...(previous.pendingChanges?.filter(
          (change) => change.code === "aggregateToolResultTruncation",
        ) ?? []),
        ...(diffSnapshots(previous.snapshot, snapshot) ?? []),
      ]
    : [];
  setTracker(key, {
    snapshot,
    lastCacheRead: previous?.lastCacheRead ?? null,
    lastCacheReadSnapshot: previous?.lastCacheReadSnapshot,
    pendingChanges: changes.length > 0 ? changes : null,
  });
  return {
    snapshot,
    changes: changes.length > 0 ? changes : null,
    previousCacheRead: previous?.lastCacheRead ?? null,
  };
}

export function recordAggregateTruncation(params: {
  sessionId: string;
  promptCacheKey?: string;
  sessionKey?: string;
}): void {
  const tracker = trackers.get(buildTrackerKey(params));
  const changes = tracker?.pendingChanges ?? [];
  if (!tracker || changes.some((change) => change.code === "aggregateToolResultTruncation")) {
    return;
  }
  tracker.pendingChanges = [
    ...changes,
    {
      code: "aggregateToolResultTruncation",
      detail: "aggregate tool-result truncation changed provider prompt",
    },
  ];
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
  const previousSnapshot = tracker.lastCacheReadSnapshot;
  tracker.lastCacheRead = cacheRead;
  tracker.lastCacheReadSnapshot = tracker.snapshot;

  if (previousCacheRead == null || previousCacheRead <= 0) {
    tracker.pendingChanges = null;
    return null;
  }

  const tokenDrop = previousCacheRead - cacheRead;
  const hasMeaningfulDrop =
    cacheRead < previousCacheRead * MAX_STABLE_CACHE_READ_RATIO &&
    tokenDrop >= MIN_CACHE_BREAK_TOKEN_DROP;
  const completeMiss =
    cacheRead === 0 &&
    (params.usage?.input ?? 0) > 0 &&
    previousSnapshot !== undefined &&
    diffSnapshots(previousSnapshot, tracker.snapshot) === null;
  const result =
    hasMeaningfulDrop || completeMiss
      ? {
          previousCacheRead,
          cacheRead,
          changes: tracker.pendingChanges,
        }
      : null;
  tracker.pendingChanges = null;
  return result;
}
