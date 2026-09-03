import {
  GitHubIdentityError,
  type prepareGitHubReadIdentity,
} from "../agents/github-tool-identity.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { ControlUiGitHubPreview } from "./control-ui-contract.js";
// Same-origin GitHub metadata adapter for Control UI link previews.
import {
  ControlUiGitHubError,
  discardResponse,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  GITHUB_REQUEST_TIMEOUT_MS,
  isRecord,
  optionalNumber,
  readOptionalGitHubString,
  readBoundedResponse,
  readGitHubJsonResponse,
  resolveGitHubApiCredentialScope,
  requiredString,
  withOptionalGitHubAuth,
} from "./control-ui-github-api.js";

const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";
const GITHUB_AVATAR_MAX_BYTES = 256 * 1024;
// One commits page bounds the extra request; the card only renders three faces,
// so deeper paging would spend quota on people it can never show.
const GITHUB_COMMITS_PAGE_SIZE = 100;
const GITHUB_COMMITS_MAX_BYTES = 1024 * 1024;
const CO_AUTHOR_FACE_LIMIT = 3;
// GitHub's noreply form is the only trailer that yields a login and an avatar
// without a lookup per person: `<accountId>+<login>@users.noreply.github.com`.
const CO_AUTHOR_TRAILER =
  /^co-authored-by:\s*[^<]*<(?<id>\d{1,12})\+(?<login>[a-z\d](?:[a-z\d-]{0,38}))@users\.noreply\.github\.com>\s*$/gimu;
const AUTHENTICATED_SUCCESS_CACHE_MS = 5 * 60_000;
const ANONYMOUS_SUCCESS_CACHE_MS = 60 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 200;

type GitHubLinkKind = "issue" | "pull";

export type ControlUiGitHubPreviewTarget = {
  kind: GitHubLinkKind;
  number: number;
  owner: string;
  repo: string;
};

export type ControlUiGitHubPreviewIdentity = Awaited<ReturnType<typeof prepareGitHubReadIdentity>>;

type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const previewCache = new Map<string, CacheEntry<ControlUiGitHubPreview>>();

function isValidOwner(value: string): boolean {
  return /^(?=.{1,39}$)[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(value);
}

function isValidRepo(value: string): boolean {
  if (value.length < 1 || value.length > 100) {
    return false;
  }
  const lower = value.toLowerCase();
  // GitHub accepts dot/underscore/hyphen edge names, including consecutive
  // periods; only reject standalone path-confusion segments before visibility.
  if (!/^[a-z\d._-]+$/iu.test(value) || lower === "." || lower === "..") {
    return false;
  }
  return !lower.endsWith(".git") && !lower.endsWith(".atom");
}

export function parseControlUiGitHubPreviewTarget(
  value: unknown,
): ControlUiGitHubPreviewTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  const number = value.number;
  if (
    (kind !== "issue" && kind !== "pull") ||
    (value.agentId !== undefined && (typeof value.agentId !== "string" || !value.agentId.trim())) ||
    !isValidOwner(owner) ||
    !isValidRepo(repo) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 9_999_999_999
  ) {
    return null;
  }
  return { kind, number, owner, repo };
}

function commitsApiUrl(target: ControlUiGitHubPreviewTarget): string {
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/pulls/${target.number}/commits?per_page=${GITHUB_COMMITS_PAGE_SIZE}`;
}

function previewApiUrl(target: ControlUiGitHubPreviewTarget): string {
  const collection = target.kind === "pull" ? "pulls" : "issues";
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/${collection}/${target.number}`;
}

function repositoryApiUrl(target: ControlUiGitHubPreviewTarget): string {
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}`;
}

async function assertPublicRepositoryUrl(
  repositoryUrl: string,
  fetchImpl: typeof fetch,
  token: string,
  identity?: ControlUiGitHubPreviewIdentity,
): Promise<void> {
  // Private and missing repositories stop at this same request boundary before
  // any item fetch, so operator.read callers cannot probe private item numbers.
  const parsed = await readGitHubJsonResponse(
    await fetchGitHubApi(repositoryUrl, fetchImpl, token, undefined, identity),
  );
  if (!isRecord(parsed) || parsed.private !== false) {
    throw new ControlUiGitHubError(404, "GitHub repository is not public");
  }
}

function redirectedRepositoryApiUrl(target: ControlUiGitHubPreviewTarget, url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const collection = target.kind === "pull" ? "pulls" : "issues";
  // The commits request redirects to the same item path plus one known suffix.
  const itemSegments = segments.at(-1) === "commits" ? segments.slice(0, -1) : segments;
  if (
    itemSegments.length === 5 &&
    itemSegments[0] === "repos" &&
    itemSegments[1] &&
    itemSegments[2] &&
    itemSegments[3] === collection &&
    /^\d+$/u.test(itemSegments[4] ?? "")
  ) {
    return `${GITHUB_API_ORIGIN}/repos/${itemSegments[1]}/${itemSegments[2]}`;
  }
  if (
    itemSegments.length === 4 &&
    itemSegments[0] === "repositories" &&
    /^\d+$/u.test(itemSegments[1] ?? "") &&
    itemSegments[2] === collection &&
    /^\d+$/u.test(itemSegments[3] ?? "")
  ) {
    return `${GITHUB_API_ORIGIN}/repositories/${itemSegments[1]}`;
  }
  return null;
}

function previewRepositoryApiUrl(
  target: ControlUiGitHubPreviewTarget,
  value: Record<string, unknown>,
): string {
  if (target.kind === "issue") {
    return requiredString(value, "repository_url");
  }
  const base = isRecord(value.base) ? value.base : {};
  const repository = isRecord(base.repo) ? base.repo : {};
  return requiredString(repository, "url");
}

function parseGitHubResponse(
  target: ControlUiGitHubPreviewTarget,
  value: unknown,
): { preview: ControlUiGitHubPreview; avatarUrl?: string } {
  if (!isRecord(value)) {
    throw new ControlUiGitHubError(502, "GitHub response was not an object");
  }
  const user = isRecord(value.user) ? value.user : {};
  return {
    preview: {
      ...target,
      additions: optionalNumber(value, "additions"),
      changedFiles: optionalNumber(value, "changed_files"),
      closedAt: readOptionalGitHubString(value, "closed_at"),
      comments: optionalNumber(value, "comments"),
      createdAt: requiredString(value, "created_at"),
      deletions: optionalNumber(value, "deletions"),
      draft: typeof value.draft === "boolean" ? value.draft : undefined,
      login: readOptionalGitHubString(user, "login") ?? "ghost",
      mergedAt: readOptionalGitHubString(value, "merged_at"),
      state: requiredString(value, "state"),
      stateReason: readOptionalGitHubString(value, "state_reason"),
      title: requiredString(value, "title"),
      updatedAt: requiredString(value, "updated_at"),
    },
    avatarUrl: readOptionalGitHubString(user, "avatar_url"),
  };
}

function safeAvatarUrl(raw: string | undefined): URL | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    const rawPathEnd = raw.search(/[?#]/u);
    const rawPath = rawPathEnd === -1 ? raw : raw.slice(0, rawPathEnd);
    if (
      url.protocol !== "https:" ||
      url.hostname !== GITHUB_AVATAR_HOST ||
      url.hash ||
      url.username ||
      url.password ||
      url.port ||
      rawPath.includes("..") ||
      rawPath.includes("\\") ||
      url.pathname.includes("..") ||
      url.pathname.includes("\\")
    ) {
      return null;
    }
    url.search = "";
    url.searchParams.set("s", "64");
    return url;
  } catch {
    return null;
  }
}

/**
 * Distinct co-author logins from a PR's commit trailers, author excluded, in
 * first-seen order. Returns the true total alongside the bounded face list so
 * the card can render "+N" without another request.
 */
async function fetchCoAuthors(
  target: ControlUiGitHubPreviewTarget,
  authorLogin: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
  beforeRedirect: ((url: URL) => Promise<void>) | undefined,
  identity?: ControlUiGitHubPreviewIdentity,
): Promise<{ coAuthors: { login: string; avatarDataUrl?: string }[]; coAuthorCount: number }> {
  const empty = { coAuthors: [], coAuthorCount: 0 };
  let commits: unknown;
  try {
    const response = await fetchGitHubApi(
      commitsApiUrl(target),
      fetchImpl,
      token,
      beforeRedirect,
      identity,
    );
    if (!response.ok) {
      await discardResponse(response);
      return empty;
    }
    commits = JSON.parse(
      (await readBoundedResponse(response, GITHUB_COMMITS_MAX_BYTES)).toString("utf8"),
    );
  } catch {
    // Co-authors are decoration on an already-useful card, so a failed or
    // oversized commits page degrades to no faces instead of failing the card.
    return empty;
  }
  if (!Array.isArray(commits)) {
    return empty;
  }
  const byLogin = new Map<string, { login: string; accountId: string }>();
  for (const entry of commits) {
    const commit = isRecord(entry) && isRecord(entry.commit) ? entry.commit : undefined;
    const message = commit ? readOptionalGitHubString(commit, "message") : undefined;
    if (!message) {
      continue;
    }
    for (const match of message.matchAll(CO_AUTHOR_TRAILER)) {
      const login = match.groups?.login;
      const accountId = match.groups?.id;
      if (!login || !accountId || login.toLowerCase() === authorLogin.toLowerCase()) {
        continue;
      }
      const key = login.toLowerCase();
      if (!byLogin.has(key)) {
        byLogin.set(key, { login, accountId });
      }
    }
  }
  const faces = [...byLogin.values()].slice(0, CO_AUTHOR_FACE_LIMIT);
  const coAuthors = await Promise.all(
    faces.map(async (face) => {
      const avatarDataUrl = await fetchAvatarDataUrl(
        `https://${GITHUB_AVATAR_HOST}/u/${face.accountId}`,
        fetchImpl,
      );
      return avatarDataUrl ? { login: face.login, avatarDataUrl } : { login: face.login };
    }),
  );
  return { coAuthors, coAuthorCount: byLogin.size };
}

async function fetchAvatarDataUrl(
  rawUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const url = safeAvatarUrl(rawUrl);
  if (!url) {
    return undefined;
  }
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (
      !response.ok ||
      !contentType ||
      !["image/gif", "image/jpeg", "image/png", "image/webp"].includes(contentType)
    ) {
      await discardResponse(response);
      return undefined;
    }
    const body = await readBoundedResponse(response, GITHUB_AVATAR_MAX_BYTES);
    return `data:${contentType};base64,${body.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function fetchPreview(
  target: ControlUiGitHubPreviewTarget,
  fetchImpl: typeof fetch,
  token?: string,
  identity?: ControlUiGitHubPreviewIdentity,
): Promise<ControlUiGitHubPreview> {
  if (token) {
    await assertPublicRepositoryUrl(repositoryApiUrl(target), fetchImpl, token, identity);
  }
  // Every credentialed fetch below shares this guard: a rename or transfer can
  // redirect into a repository the token can read but the viewer may not see.
  const beforeRedirect = token
    ? async (url: URL) => {
        const repositoryUrl = redirectedRepositoryApiUrl(target, url);
        if (!repositoryUrl) {
          throw new ControlUiGitHubError(502, "GitHub item returned an unsafe redirect");
        }
        await assertPublicRepositoryUrl(repositoryUrl, fetchImpl, token, identity);
      }
    : undefined;
  const parsed = await readGitHubJsonResponse(
    await fetchGitHubApi(previewApiUrl(target), fetchImpl, token, beforeRedirect, identity),
  );
  if (!isRecord(parsed)) {
    throw new ControlUiGitHubError(502, "GitHub response was not an object");
  }
  if (token) {
    await assertPublicRepositoryUrl(
      previewRepositoryApiUrl(target, parsed),
      fetchImpl,
      token,
      identity,
    );
  }
  const { preview, avatarUrl } = parseGitHubResponse(target, parsed);
  // Both extra fetches run only after the public-repository assertions above,
  // so neither can widen what this token is allowed to read.
  const [avatarDataUrl, coAuthorFacts] = await Promise.all([
    fetchAvatarDataUrl(avatarUrl, fetchImpl),
    target.kind === "pull"
      ? fetchCoAuthors(target, preview.login, fetchImpl, token, beforeRedirect, identity)
      : Promise.resolve({ coAuthors: [], coAuthorCount: 0 }),
  ]);
  return {
    ...preview,
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    ...(coAuthorFacts.coAuthorCount > 0
      ? { coAuthors: coAuthorFacts.coAuthors, coAuthorCount: coAuthorFacts.coAuthorCount }
      : {}),
  };
}

function cacheKey(target: ControlUiGitHubPreviewTarget, credentialScope: string): string {
  return `${target.kind}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}\0${credentialScope}`;
}

function cachePreview(key: string, entry: CacheEntry<ControlUiGitHubPreview>): void {
  previewCache.set(key, entry);
  pruneMapToMaxSize(previewCache, CACHE_LIMIT);
}

export async function loadControlUiGitHubPreview(
  target: ControlUiGitHubPreviewTarget,
  identity?: ControlUiGitHubPreviewIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<ControlUiGitHubPreview> {
  await identity?.revalidate();
  identity?.assertSelected();
  const { token, cacheScope } = identity ?? resolveGitHubApiCredentialScope();
  const key = cacheKey(target, cacheScope);
  const now = Date.now();
  let entry = previewCache.get(key);
  if (entry && entry.expiresAt <= now) {
    previewCache.delete(key);
    entry = undefined;
  }
  if (entry) {
    previewCache.delete(key);
    previewCache.set(key, entry);
  } else {
    const successCacheMs = token ? AUTHENTICATED_SUCCESS_CACHE_MS : ANONYMOUS_SUCCESS_CACHE_MS;
    const request = identity
      ? fetchPreview(target, fetchImpl, token, identity)
      : withOptionalGitHubAuth(token, (requestToken) =>
          fetchPreview(target, fetchImpl, requestToken),
        );
    const pending: CacheEntry<ControlUiGitHubPreview> = {
      expiresAt: now + successCacheMs,
      promise: request.then(
        (preview) => {
          if (identity) {
            cachePreview(key, pending);
          }
          return preview;
        },
        (error: unknown) => {
          // Lifecycle failures belong to this caller; only upstream failures
          // may suppress later requests from other readers of the credential.
          if (!(error instanceof GitHubIdentityError)) {
            pending.expiresAt = Date.now() + FAILURE_CACHE_MS;
            cachePreview(key, pending);
          }
          throw error;
        },
      ),
    };
    entry = pending;
    // A managed in-flight request carries its caller's live identity closure.
    // Share its settled result, never its transport with another connection.
    if (!identity) {
      cachePreview(key, entry);
    }
  }
  const preview = await entry.promise;
  // Transport is credential-scoped, but every reader must still hold its
  // current identity before cached or newly fetched metadata is delivered.
  await identity?.revalidate();
  identity?.assertSelected();
  return preview;
}
