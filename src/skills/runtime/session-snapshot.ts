// Session snapshot helpers capture and restore runtime skill state for sessions.
import crypto from "node:crypto";
import { stableStringify } from "../../agents/stable-stringify.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { matchesSkillFilter } from "../discovery/filter.js";
import { buildWorkspaceSkillSnapshot } from "../loading/workspace.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion } from "./refresh-state.js";
import { ensureSkillsWatcher } from "./refresh.js";
import { hydrateResolvedSkills } from "./snapshot-hydration.js";

const resolvedSkillsCache = new Map<string, SkillSnapshot["resolvedSkills"]>();
const RESOLVED_SKILLS_CACHE_MAX = 10;

/** Inputs that make a resolved skill snapshot reusable within a process. */
export type ReusableSkillSnapshotParams = {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
  existingSnapshot?: SkillSnapshot;
  snapshotVersion?: number;
  watch?: boolean;
  hydrateExisting?: boolean;
};

export type ReusableSkillSnapshotResult = {
  snapshot: SkillSnapshot;
  shouldRefresh: boolean;
  snapshotVersion: number;
};

export function resetResolvedSkillsCacheForTests(): void {
  resolvedSkillsCache.clear();
}

function fingerprintSkillSnapshotConfig(config: OpenClawConfig): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(redactConfigObject(config)))
    .digest("hex");
}

function cacheResolvedSkills(cacheKey: string, snapshot: SkillSnapshot): SkillSnapshot {
  resolvedSkillsCache.set(cacheKey, snapshot.resolvedSkills);
  if (resolvedSkillsCache.size > RESOLVED_SKILLS_CACHE_MAX) {
    const oldest = resolvedSkillsCache.keys().next().value;
    if (oldest !== undefined) {
      resolvedSkillsCache.delete(oldest);
    }
  }
  return snapshot;
}

export function resolveReusableWorkspaceSkillSnapshot(
  params: ReusableSkillSnapshotParams,
): ReusableSkillSnapshotResult {
  if (params.watch !== false) {
    ensureSkillsWatcher({ workspaceDir: params.workspaceDir, config: params.config });
  }
  const snapshotVersion = params.snapshotVersion ?? getSkillsSnapshotVersion(params.workspaceDir);
  const shouldRefresh =
    shouldRefreshSnapshotForVersion(params.existingSnapshot?.version, snapshotVersion) ||
    !matchesSkillFilter(params.existingSnapshot?.skillFilter, params.skillFilter);
  const buildSnapshot = () => {
    return buildWorkspaceSkillSnapshot(params.workspaceDir, {
      config: params.config,
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      eligibility: params.eligibility,
      snapshotVersion,
    });
  };

  const configFingerprint = fingerprintSkillSnapshotConfig(params.config);
  const snapshotCacheKey = JSON.stringify([
    params.workspaceDir,
    snapshotVersion,
    params.skillFilter,
    params.agentId,
    params.eligibility,
    configFingerprint,
  ]);

  const cachedRebuild = (): SkillSnapshot => {
    if (resolvedSkillsCache.has(snapshotCacheKey)) {
      return { resolvedSkills: resolvedSkillsCache.get(snapshotCacheKey) } as SkillSnapshot;
    }
    return cacheResolvedSkills(snapshotCacheKey, buildSnapshot());
  };

  const snapshot =
    !params.existingSnapshot || shouldRefresh
      ? cacheResolvedSkills(snapshotCacheKey, buildSnapshot())
      : params.hydrateExisting === false
        ? params.existingSnapshot
        : hydrateResolvedSkills(params.existingSnapshot, cachedRebuild);
  return { snapshot, shouldRefresh, snapshotVersion };
}
