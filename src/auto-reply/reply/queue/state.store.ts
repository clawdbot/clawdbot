import path from "node:path";

import { STATE_DIR } from "../../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../../infra/json-file.js";
import type { FollowupQueueState } from "./state.js";

export type PersistedFollowupQueueVersion = 1;

type PersistedFollowupQueueRegistry = {
  version: 1;
  queues: Record<string, PersistedFollowupQueueState>;
};

type PersistedFollowupQueueState = FollowupQueueState;

const REGISTRY_VERSION = 1 as const;

export function resolveFollowupQueueRegistryPath(): string {
  return path.join(STATE_DIR, "followup-queues", "queues.json");
}

export function loadFollowupQueuesFromDisk(): Map<string, FollowupQueueState> {
  const pathname = resolveFollowupQueueRegistryPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") return new Map();
  const record = raw as Partial<PersistedFollowupQueueRegistry>;
  if (record.version !== 1) return new Map();
  const queuesRaw = record.queues;
  if (!queuesRaw || typeof queuesRaw !== "object") return new Map();
  const out = new Map<string, FollowupQueueState>();
  for (const [key, entry] of Object.entries(queuesRaw)) {
    if (!entry || typeof entry !== "object") continue;
    // Reset draining state on restore - will be restarted if items exist
    const restored: FollowupQueueState = {
      ...entry,
      draining: false,
    };
    out.set(key, restored);
  }
  return out;
}

export function saveFollowupQueuesToDisk(queues: Map<string, FollowupQueueState>) {
  const pathname = resolveFollowupQueueRegistryPath();
  const serialized: Record<string, PersistedFollowupQueueState> = {};
  for (const [key, entry] of queues.entries()) {
    // Only persist queues that have items or have been used recently
    if (entry.items.length > 0 || entry.droppedCount > 0 || entry.lastEnqueuedAt > 0) {
      serialized[key] = entry;
    }
  }
  const out: PersistedFollowupQueueRegistry = {
    version: REGISTRY_VERSION,
    queues: serialized,
  };
  saveJsonFile(pathname, out);
}
