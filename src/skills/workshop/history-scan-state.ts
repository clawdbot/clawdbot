import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createCorePluginStateSyncKeyedStore,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
} from "../../plugin-state/plugin-state-store.js";
import type { SkillWorkshopProposalReviewProgress } from "./types.js";

const HISTORY_SCAN_SCHEMA = "openclaw.skill-workshop.history-scan.v1";

export type SkillHistoryScanDirection = "older" | "newer";

export type SkillHistoryScanResult = {
  schema: typeof HISTORY_SCAN_SCHEMA;
  hasScanned: boolean;
  reviewedSessions: number;
  ideasFound: number;
  hasMore: boolean;
  lastScanReviewed: number;
  lastScanIdeas: number;
  lastScanAt?: string;
  oldestReviewedAt?: string;
  newestReviewedAt?: string;
};

export type SkillHistoryScanCursor = {
  instanceId: string;
  updatedAtMs: number;
};

export type StoredSkillHistoryScanSnapshot = SkillHistoryScanResult & {
  oldestCursor?: SkillHistoryScanCursor;
  newestCursor?: SkillHistoryScanCursor;
};

export type StoredSkillHistoryScanState = StoredSkillHistoryScanSnapshot & {
  pending?: {
    direction: SkillHistoryScanDirection;
    runId: string;
    next: StoredSkillHistoryScanSnapshot;
    progress: SkillWorkshopProposalReviewProgress;
    sessionCursors: SkillHistoryScanCursor[];
    completed?: { ideasFound: number };
  };
};

export type SkillHistoryScanScope = {
  agentId: string;
  config: OpenClawConfig;
  direction?: SkillHistoryScanDirection;
  env?: NodeJS.ProcessEnv;
  workspaceDir: string;
};

export function historyScanStore(env?: NodeJS.ProcessEnv) {
  return createCorePluginStateSyncKeyedStore<StoredSkillHistoryScanState>({
    ownerId: "core:skill-workshop",
    namespace: "history-scan",
    maxEntries: MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

export function historyScanStateKey(
  agentId: string,
  workspaceDir: string,
  storePath: string,
): string {
  const scope = createHash("sha256")
    .update(`${agentId}\0${path.resolve(workspaceDir)}\0${path.resolve(storePath)}`)
    .digest("hex");
  return `${agentId}:${scope}`;
}

export function emptyHistoryScanResult(): SkillHistoryScanResult {
  return {
    schema: HISTORY_SCAN_SCHEMA,
    hasScanned: false,
    reviewedSessions: 0,
    ideasFound: 0,
    hasMore: false,
    lastScanReviewed: 0,
    lastScanIdeas: 0,
  };
}

export function isStoredHistoryScanState(value: unknown): value is StoredSkillHistoryScanState {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === HISTORY_SCAN_SCHEMA,
  );
}

function loadHistoryScanState(params: Omit<SkillHistoryScanScope, "direction">) {
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const value = historyScanStore(params.env).lookup(
    historyScanStateKey(params.agentId, params.workspaceDir, storePath),
  );
  return isStoredHistoryScanState(value) ? value : undefined;
}

export function getSkillHistoryScanStatus(
  params: Omit<SkillHistoryScanScope, "direction">,
): SkillHistoryScanResult {
  return toPublicHistoryScanResult(loadHistoryScanState(params) ?? emptyHistoryScanResult());
}

export function toPublicHistoryScanResult(
  state: StoredSkillHistoryScanState,
): SkillHistoryScanResult {
  const {
    oldestCursor: _oldestCursor,
    newestCursor: _newestCursor,
    pending: _pending,
    ...result
  } = state;
  return result;
}

export function withoutPendingHistoryScan(
  state: StoredSkillHistoryScanState,
): StoredSkillHistoryScanSnapshot {
  const { pending: _pending, ...snapshot } = state;
  return snapshot;
}

export function withHistoryScanIdeas(params: {
  next: StoredSkillHistoryScanSnapshot;
  previous: StoredSkillHistoryScanSnapshot;
  ideasFound: number;
}): StoredSkillHistoryScanSnapshot {
  return {
    ...params.next,
    ideasFound: params.previous.ideasFound + params.ideasFound,
    lastScanIdeas: params.ideasFound,
  };
}
