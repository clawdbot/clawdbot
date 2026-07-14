export type ChangedLane =
  | "core"
  | "coreTests"
  | "ui"
  | "extensions"
  | "extensionTests"
  | "scripts"
  | "testRoot"
  | "apps"
  | "docs"
  | "tooling"
  | "liveDockerTooling"
  | "releaseMetadata"
  | "all";

export type ChangedLanes = Record<ChangedLane, boolean>;

export type ChangedLaneResult = {
  paths: string[];
  lanes: ChangedLanes;
  extensionImpactFromCore: boolean;
  docsOnly: boolean;
  reasons: string[];
};

export type DetectChangedLanesOptions = {
  packageJsonChangeKind?: "liveDockerTooling" | "tooling" | null;
};

export function createEmptyChangedLanes(): ChangedLanes;
export function isChangedLaneTestPath(changedPath: string): boolean;
export function detectChangedLanes(
  changedPaths: string[],
  options?: DetectChangedLanesOptions,
): ChangedLaneResult;
export function detectChangedLanesForPaths(params: {
  paths: string[];
  base: string;
  head?: string;
  staged?: boolean;
  mergeHeadFirstParent?: boolean;
}): ChangedLaneResult;
export function listChangedPathsFromGit(params: {
  base: string;
  head?: string;
  includeWorktree?: boolean;
  cwd?: string;
  mergeHeadFirstParent?: boolean;
}): string[];
export function listStagedChangedPaths(cwd?: string): string[];
export function isLiveDockerPackageScriptOnlyChange(before: string, after: string): boolean;
export function isPackageScriptOnlyChange(before: string, after: string): boolean;

export const LIVE_DOCKER_AUTH_SHELL_TARGETS: string[];
export const RELEASE_METADATA_PATHS: Set<string>;
