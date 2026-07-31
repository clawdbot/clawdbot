export const GITHUB_API_REQUEST_TIMEOUT_MS: number;
export const GITHUB_ERROR_BODY_MAX_BYTES: number;
export const GITHUB_RESPONSE_BODY_MAX_BYTES: number;
export const allowSecuritySensitiveCommand: string;
export const securitySensitiveGuardMarker: string;
type Comment = { body?: string; created_at?: string; html_url?: string; user?: { login?: string } };
type ActorCandidate = { login: string; source: string };
export function securitySensitiveFileDefinitions(): Array<{ path: string; reason: string }>;
export function securitySensitiveFileDefinition(
  filename: string,
): { path: string; reason: string } | undefined;
export function isSecuritySensitiveFile(filename: string): boolean;
export function sanitizeDisplayValue(value: unknown): string;
export function markdownCode(value: unknown): string;
export function findSecuritySensitiveOverrideCommand(options: {
  comments: Comment[];
  expectedSha: string;
  isSecurityMember: (login: string) => boolean;
  newerThan?: string;
}): { login: string; reason: string | null; sha: string; url?: string } | null;
export function findSecuritySensitiveOverrideCommandAsync(options: {
  comments: Comment[];
  expectedSha: string;
  isSecurityMember: (login: string) => Promise<boolean>;
  newerThan?: string;
}): Promise<{ login: string; reason: string | null; sha: string; url?: string } | null>;
export function securitySensitiveGuardCommentHeadSha(comment: Comment): string | null;
export function securitySensitiveOverrideExpectedSha(
  comment: Comment | null,
  currentHeadSha: string,
): string | null;
export function isSecuritySensitiveGuardAuthorizedForHead(
  comment: Comment,
  currentHeadSha: string,
): boolean;
export function isSecuritySensitiveGuardTrustedForHead(
  comment: Comment,
  currentHeadSha: string,
): boolean;
export function securityApproverSet(value: unknown): Set<string>;
export function securitySensitiveGuardCommentAuthors(value?: unknown): Set<string>;
export function isSecuritySensitiveGuardMarkerComment(
  comment: Comment,
  trustedAuthors: Set<string>,
): boolean;
export function collectSecuritySensitiveChanges(
  files: Array<{ filename: string; previous_filename?: string; status?: string }>,
): Array<Record<string, string>>;
export function renderSecuritySensitiveAwarenessComment(
  changes: Array<Record<string, string>>,
): string;
export function renderAuthorizedSecuritySensitiveComment(override: Record<string, unknown>): string;
export function renderTrustedSecuritySensitiveComment(options: Record<string, unknown>): string;
export function renderClearedSecuritySensitiveGuardComment(options: { headSha: string }): string;
export function renderBlockedSecuritySensitiveComment(options: Record<string, unknown>): string;
export function securitySensitiveGuardTrustedActorCandidates(
  options: Record<string, unknown>,
): ActorCandidate[];
export function findTrustedSecuritySensitiveGuardActor(options: {
  candidates: ActorCandidate[];
  isSecuritySensitiveApprover: (login: string) => Promise<string | null>;
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
export function readBoundedGitHubErrorText(
  response: Response,
  maxBytes?: number,
  options?: { signal?: AbortSignal },
): Promise<string>;
export function readBoundedGitHubJson(
  response: Response,
  maxBytes?: number,
  options?: { signal?: AbortSignal },
): Promise<unknown>;
