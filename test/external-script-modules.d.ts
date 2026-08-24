declare module "*security/opengrep/check-rule-metadata.mjs" {
  export function validateRuleMetadata(
    rules: Array<{ id: string; metadata?: Record<string, string> }>,
  ): string[];
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
  export function contributionRecordTarget(section: { source: string }): string | undefined;
  export function pullRequestTitleFromCommitSubject(
    subject: string,
    number: number,
  ): string | undefined;
  export function contributionRecordFor(section: Record<string, unknown>): {
    legacyIssues: Map<number, unknown>;
    pullRequests: Map<number, ContributionRecord>;
  };
  export function recoverUnavailablePullRequests(params: {
    numbers: Iterable<number>;
    nodes: Map<number, unknown>;
    record: { pullRequests: Map<number, ContributionRecord> };
    recordTarget?: string;
    source: {
      activeCommits: Array<{
        authorHandle?: string;
        closingReferences?: number[];
        committedAt: string;
        hash: string;
        pullRequests: number[];
        references: number[];
        subject: string;
      }>;
      coauthorsByReference: Map<number, Set<string>>;
      pullRequests: Set<number>;
      target: string;
    };
    isAncestor?: (ancestor: string, descendant: string) => boolean;
  }): Map<number, unknown>;
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
    releaseProvenance?: string[],
  ): Map<string, number[]>;
  export function parseArgs(argv: string[]): {
    releaseProvenance: string[];
    [key: string]: unknown;
  };
  export function resolvedReleasePullRequests(
    currentPullRequests: number[],
    mainPullRequests: number[],
    hasCanonicalMainCommit: boolean,
    provenanceOverride?: number[],
  ): number[];
  export function releasePullRequestReferencesToSuppress(
    currentPullRequests: number[],
    subject: string,
    associatedPullRequests: number[],
    hasProvenanceOverride: boolean,
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
  export function isEligibleHandle(handle: string): boolean;
  export function ledgerChecks(...args: unknown[]): string[];
}
