// Session snapshot helpers capture and restore runtime skill state for sessions.
import { stableStringify } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { matchesSkillFilter } from "../discovery/filter.js";
import {
  loadMergedWorkspaceSkills,
  normalizeWorkspaceSkillRoots,
} from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion } from "./refresh-state.js";
import { ensureSkillsWatcher } from "./refresh.js";
import { fingerprintSkillSnapshotConfig } from "./snapshot-config-fingerprint.js";
import { hydrateResolvedSkills } from "./snapshot-hydration.js";

// The resolved index is gateway-process state. Mutation RPCs and watcher events
// must bump that same process's version so a new-session key cannot reuse it.
const resolvedSkillsCache = new Map<string, SkillSnapshot["resolvedSkills"]>();
const RESOLVED_SKILLS_CACHE_MAX = 10;

/** Inputs that make a resolved skill snapshot reusable within a process. */
type ReusableSkillSnapshotParams = {
  workspaceDir: string;
  executionSkillsDir?: string;
  config: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  eligibility?: SkillEligibilityContext;
  existingSnapshot?: SkillSnapshot;
  snapshotVersion?: number;
  watch?: boolean;
  hydrateExisting?: boolean;
};

type ReusableSkillSnapshotResult = {
  snapshot: SkillSnapshot;
  shouldRefresh: boolean;
  snapshotVersion: number;
};

function cacheResolvedSkills(cacheKey: string, snapshot: SkillSnapshot): SkillSnapshot {
  resolvedSkillsCache.set(cacheKey, snapshot.resolvedSkills);
  pruneMapToMaxSize(resolvedSkillsCache, RESOLVED_SKILLS_CACHE_MAX);
  return snapshot;
}

export function resolveReusableWorkspaceSkillSnapshot(
  params: ReusableSkillSnapshotParams,
): ReusableSkillSnapshotResult {
  const normalizedRoots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: params.workspaceDir,
    ...(params.executionSkillsDir ? { executionSkillsDir: params.executionSkillsDir } : {}),
  });
  const skillRoots = normalizedRoots.executionSkillsDir
    ? {
        agentWorkspaceDir: normalizedRoots.agentWorkspaceDir,
        executionSkillsDir: normalizedRoots.executionSkillsDir,
      }
    : undefined;
  const watcherWorkspaceDir = skillRoots?.agentWorkspaceDir ?? params.workspaceDir;
  if (params.watch !== false) {
    ensureSkillsWatcher({
      workspaceDir: watcherWorkspaceDir,
      ...(skillRoots ? { executionSkillsDir: skillRoots.executionSkillsDir } : {}),
      config: params.config,
    });
  }
  const snapshotVersion = params.snapshotVersion ?? getSkillsSnapshotVersion(watcherWorkspaceDir);
  const promptFormatChanged =
    params.existingSnapshot?.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION;
  const skillVersionChanged = shouldRefreshSnapshotForVersion(
    params.existingSnapshot?.version,
    snapshotVersion,
  );
  const nodeSkillsEligibilityChanged =
    stableStringify(params.existingSnapshot?.nodeSkillsEligibility) !==
    stableStringify(params.eligibility?.nodeSkills);
  const skillOverridesChanged =
    stableStringify(params.existingSnapshot?.skillOverrides) !==
    stableStringify(params.skillOverrides);
  const skillRootsChanged =
    stableStringify(params.existingSnapshot?.skillRoots) !== stableStringify(skillRoots);
  const shouldRefresh =
    promptFormatChanged ||
    skillVersionChanged ||
    nodeSkillsEligibilityChanged ||
    skillRootsChanged ||
    !matchesSkillFilter(params.existingSnapshot?.skillFilter, params.skillFilter) ||
    skillOverridesChanged;
  const buildSnapshot = () => {
    const entries = skillRoots
      ? loadMergedWorkspaceSkills({
          ...skillRoots,
          config: params.config,
          agentId: params.agentId,
          skillFilter: params.skillFilter,
          skillOverrides: params.skillOverrides,
          eligibility: params.eligibility,
        })
      : undefined;
    const snapshot = buildSkillSnapshot(params.workspaceDir, {
      config: params.config,
      ...(entries ? { entries, preserveEntryOrder: true } : {}),
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      skillOverrides: params.skillOverrides,
      eligibility: params.eligibility,
      snapshotVersion,
    });
    return skillRoots ? { ...snapshot, skillRoots } : snapshot;
  };

  const buildSnapshotCacheKey = () =>
    JSON.stringify([
      params.workspaceDir,
      skillRoots,
      snapshotVersion,
      params.skillFilter,
      params.skillOverrides,
      params.agentId,
      params.eligibility,
      fingerprintSkillSnapshotConfig(params.config),
    ]);

  const cachedRebuild = (snapshotCacheKey = buildSnapshotCacheKey()): SkillSnapshot => {
    if (resolvedSkillsCache.has(snapshotCacheKey)) {
      return { resolvedSkills: resolvedSkillsCache.get(snapshotCacheKey) } as SkillSnapshot;
    }
    return cacheResolvedSkills(snapshotCacheKey, buildSnapshot());
  };

  const snapshot =
    !params.existingSnapshot || shouldRefresh
      ? cacheResolvedSkills(buildSnapshotCacheKey(), buildSnapshot())
      : params.hydrateExisting === false
        ? params.existingSnapshot
        : hydrateResolvedSkills(params.existingSnapshot, cachedRebuild);
  return { snapshot, shouldRefresh, snapshotVersion };
}
