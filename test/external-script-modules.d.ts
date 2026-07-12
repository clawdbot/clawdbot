declare module "*security/opengrep/check-rule-metadata.mjs" {
  export function validateRuleMetadata(
    rules: Array<{ id: string; metadata?: Record<string, string> }>,
  ): string[];
}

declare module "*scripts/ui.js" {
  type SpawnCall = {
    command: string;
    args: string[];
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      shell: boolean;
      stdio: string;
      windowsVerbatimArguments?: boolean;
    };
  };
  export function shouldUseCmdExeForCommand(cmd: string, platform?: NodeJS.Platform): boolean;
  export function resolveSpawnCall(
    cmd: string,
    args: string[],
    envOverride?: NodeJS.ProcessEnv,
    params?: { comSpec?: string; cwd?: string; nodeExecPath?: string; platform?: NodeJS.Platform },
  ): SpawnCall;
  export function resolvePnpmSpawnCall(
    pnpmArgs: string[],
    envOverride?: NodeJS.ProcessEnv,
    params?: { comSpec?: string; cwd?: string; nodeExecPath?: string; platform?: NodeJS.Platform },
  ): SpawnCall;
  export function isDirectScriptExecution(
    entry?: string,
    scriptPath?: string,
    realpath?: (path: string) => string,
  ): boolean;
}

declare module "*openclaw-changelog-update/scripts/verify-release-notes.mjs" {
  type ContributionRecord = {
    externalReferences?: string[];
    references: number[];
    thanks: string[];
  };
  export function createGithubSnapshotState(params: Record<string, unknown>): {
    base: string;
    checkpointEvery: number;
    dirty: boolean;
    filePath: string;
    hits: number;
    misses: number;
    repository: string;
    responses: Record<string, unknown>;
    target: string;
    writesSincePersist: number;
  };
  export function githubApiWithSnapshot(
    args: string[],
    fetchApi: (args: string[]) => unknown,
    snapshotState: Record<string, unknown>,
  ): unknown;
  export function persistGithubSnapshot(snapshotState: Record<string, unknown>): void;
  export function defaultGithubSnapshotPath(
    base: string,
    target: string,
    gitCommonDir: string,
  ): string;
  export function renderContributionRecordEntry(entry: Record<string, unknown>): string;
  export function releaseNoteReferences(
    sectionSource: string,
    shippedBaselines: unknown[],
  ): number[];
  export function standardRevertedHash(message: string): string | null;
  export function contributionRecordFor(section: Record<string, unknown>): {
    legacyIssues: Map<number, unknown>;
    pullRequests: Map<number, ContributionRecord>;
  };
  export function cumulativeShippedPullRequests(changelog: unknown, label: string): Set<number>;
  export function subtractShippedPullRequests(
    source: unknown,
    baselines: unknown[],
  ): {
    baselines: unknown[];
    pullRequests: Set<number>;
  };
  export function withoutExcludedContributionRecords(
    record: {
      legacyIssues: Map<number, ContributionRecord>;
      pullRequests: Map<number, ContributionRecord>;
    },
    excluded: Set<number>,
  ): {
    legacyIssues: Map<number, ContributionRecord>;
    pullRequests: Map<number, ContributionRecord>;
  };
  export function renderedContributionRecordReferences(
    record: {
      legacyIssues: Map<number, ContributionRecord>;
      pullRequests: Map<number, ContributionRecord>;
    },
    writeLedger: boolean,
  ): number[];
  export function contaminatingPullRequestReferences(params: Record<string, unknown>): unknown[];
  export function canonicalMainCommitMatches(commit: unknown, candidates: unknown[]): unknown[];
  export function canonicalPullRequests(
    currentPullRequests: unknown[],
    mainPullRequests: unknown[],
    hasCanonicalMainCommit?: boolean,
  ): unknown[];
  export function releaseProvenanceMarkers(
    message: string,
  ): Array<{ commit: string; pullRequests: number[] }>;
  export function collectReleaseProvenanceOverrides(
    activeCommits: Array<{ body: string; hash: string }>,
  ): Map<string, number[]>;
  export function resolvedReleasePullRequests(
    currentPullRequests: number[],
    mainPullRequests: number[],
    hasCanonicalMainCommit: boolean,
    provenanceOverride?: number[],
  ): number[];
  export function validateReleaseProvenanceOverrides(
    provenanceOverrides: Map<string, number[]>,
    nodes: Map<number, unknown>,
    mainCommit: string,
    isMainAncestor?: (ancestor: string, descendant: string) => boolean,
  ): void;
  export function ledgerFor(...args: unknown[]): {
    entries: unknown[];
    issues: unknown[];
    ledger: string;
    pullRequests: unknown[];
    titleReferences: unknown[];
  };
  export function countTopLevelSectionBullets(sectionSource: string, heading: string): number;
  export function highlightCountError(sectionSource: string): string | undefined;
  export function ledgerChecks(...args: unknown[]): string[];
}

declare module "*openclaw-live-updater/scripts/update-main.mjs" {
  type GatewayDeployment = Record<string, unknown> & {
    entrypoint: string;
    workingDirectory?: string | null;
  };
  type UpdateResult = Record<string, unknown> & {
    actions: Record<string, unknown>;
    buildBefore: Record<string, unknown>;
    changedPaths?: string[];
    macTarget?: Record<string, unknown>;
    release?: () => void;
  };
  export function originMatches(remoteUrl: string): boolean;
  export function isOwnedGatewayEntrypoint(
    checkout: string,
    home: string,
    entrypoint: string,
  ): boolean;
  export function parseLaunchctlArguments(output: string): string[];
  export function resolveManagedGatewayEntrypoint(
    programArguments: string[],
    home: string,
    stateDir?: string,
  ): string | null;
  export function replaceLaunchAgentProgramArgument(
    programArguments: unknown,
    index: number,
    expected: string,
    replacement: string,
  ): string[];
  export function repointManagedGatewayDeployment(
    checkout: string,
    deployment: GatewayDeployment,
    replaceEntrypoint: (deployment: GatewayDeployment, replacement: string) => void,
    inspectDeployment?: (checkout: string) => GatewayDeployment | null,
  ): GatewayDeployment & { changed: boolean; previousEntrypoint?: string };
  export function runBuiltGatewayCall(
    checkout: string,
    method: string,
    params: Record<string, unknown>,
    deployment?: GatewayDeployment | null,
  ): string;
  export function classifyActions(
    changedPaths: string[],
    options: Record<string, unknown>,
  ): Record<string, unknown>;
  export function inspectBuildState(checkout: string, expectedSha: string): UpdateResult;
  export function acquireMaintenanceLock(
    checkout: string,
    requestedPath?: string,
  ): {
    acquired: boolean;
    owner: { pid: number; checkout?: string; startedAt?: string };
    release?: () => void;
  };
  export function parseGatewayLogAudit(
    output: string,
    sinceMs: number,
    sourceRoot?: string | null,
    managedSourceRoots?: string[] | null,
  ): Record<string, unknown>;
  export function resolveManagedPluginSourceRoots(report: unknown): string[] | null;
  export function resolveManagedGatewaySourceRoot(
    checkout: string,
    deployment?: GatewayDeployment | null,
  ): string;
  export function prepareGatewaySuspension(
    checkout: string,
    callGateway?: (
      checkout: string,
      method: string,
      params: { requestId: string },
      deployment: GatewayDeployment | null,
    ) => string,
    deployment?: GatewayDeployment | null,
  ):
    | { status: "ready"; suspensionId: string }
    | {
        status: "busy";
        reason: string;
        retryAfterMs: number;
        activeCount: number;
        blockers: Array<{ kind: string; count: number; message: string }>;
      };
  export function verifyGatewayReadiness(
    runCommand: (command: string, args: string[], checkout: string) => unknown,
    checkout: string,
    expectedSha: string,
    sleep?: (ms: number) => void,
  ): void;
  export function findExactMacTarget(
    processes: string,
    executable: string,
  ): { executable: string; pid: number } | null;
  export function maintainMain(
    options: Record<string, unknown>,
    dependencies?: Record<string, unknown>,
  ): UpdateResult;
}
