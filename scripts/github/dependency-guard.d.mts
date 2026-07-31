export const GITHUB_API_REQUEST_TIMEOUT_MS: number;
export const GITHUB_ERROR_BODY_MAX_BYTES: number;
export const GITHUB_RESPONSE_BODY_MAX_BYTES: number;
export const dependencyChangedLabel: "dependencies-changed";

type Comment = {
  body?: string;
  created_at?: string;
  html_url?: string;
  user?: { login?: string };
};

type PullRequest = {
  head?: { ref?: string; repo?: { full_name?: string }; sha?: string };
  maintainer_can_modify?: boolean;
  user?: { login?: string };
};

type ActorCandidate = { login: string; source: string };

export function isDependencyFile(filename: string): boolean;
export function isDependencyManifest(filename: string): boolean;
export function isPackageLockfile(filename: string): boolean;
export function dependencyFieldChanges(
  baseManifest: Record<string, unknown>,
  headManifest: Record<string, unknown>,
): string[];
export function shouldAutoscrubDependencyLockfiles(options: {
  dependencyFiles?: string[];
  lockfileChanges: unknown[];
  dependencyManifestChanges?: unknown[];
}): boolean;
export function canAutoscrubPullRequest(options: {
  owner: string;
  repo: string;
  pullRequest: PullRequest;
}): boolean;
export function sanitizeDisplayValue(value: unknown): string;
export function markdownCode(value: unknown): string;
export function readBoundedGitHubJson(
  response: Response,
  maxBytes?: number,
  options?: { signal?: AbortSignal },
): Promise<unknown>;
export function findDependencyOverrideCommand(options: {
  comments: Comment[];
  expectedSha: string;
  isSecurityMember: (login: string) => boolean;
  newerThan?: string;
}): { login: string; reason: string | null; sha: string; url?: string } | null;
export function findDependencyOverrideCommandAsync(options: {
  comments: Comment[];
  expectedSha: string;
  isSecurityMember: (login: string) => Promise<boolean>;
  newerThan: string;
}): Promise<{ login: string; reason: string | null; sha: string; url?: string } | null>;
export function dependencyGuardCommentHeadSha(comment: Comment): string | null;
export function dependencyOverrideExpectedSha(
  existingGuardComment: Comment | null,
  currentHeadSha: string,
): string | null;
export function isDependencyGuardAuthorizedForHead(
  comment: Comment,
  currentHeadSha: string,
): boolean;
export function isDependencyGuardTrustedForHead(comment: Comment, currentHeadSha: string): boolean;
export function securityApproverSet(value: unknown): Set<string>;
export function dependencyGuardCommentAuthors(value?: unknown): Set<string>;
export function isDependencyGuardMarkerComment(
  comment: Comment,
  marker: string,
  trustedAuthors: Set<string>,
): boolean;
export function renderAuthorizedDependencyComment(override: Record<string, unknown>): string;
export function renderTrustedDependencyComment(options: {
  actor: { login: string; reason: string };
  headSha: string;
}): string;
export function renderAutoscrubbedDependencyComment(options: {
  baseBranch: string;
  lockfileChanges: string[];
  commitSha: string;
}): string;
export function isAutoscrubbedDependencyComment(comment: Comment): boolean;
export function renderClearedDependencyGuardComment(options: { headSha: string }): string;
export function renderBlockedDependencyComment(options: Record<string, unknown>): string;
export function dependencyGuardTrustedActorCandidates(options: {
  pullRequest: PullRequest;
  event: Record<string, unknown>;
  currentHeadSha: string;
}): ActorCandidate[];
export function findTrustedDependencyGuardActor(options: {
  candidates: ActorCandidate[];
  isDependencyApprover: (login: string) => Promise<string | null>;
}): Promise<{ login: string; reason: string } | null>;
export function githubApi(
  token: string,
  options?: {
    fetchImpl?: typeof fetch;
    responseMaxBodyBytes?: number;
    retryDelaysMs?: readonly number[];
    timeoutMs?: number;
  },
): { request(path: string, options?: Record<string, unknown>): Promise<unknown> };
export function createAutoscrubCommit(...args: unknown[]): Promise<unknown>;
export function readBoundedGitHubErrorText(...args: unknown[]): Promise<string>;
