import type {
  RemoteProject,
  ProjectsSearchRemoteResult,
} from "../../packages/gateway-protocol/src/index.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { parseProjectGitUrl } from "../projects/project-git-url.js";
import {
  fetchGitHubApi,
  fetchGitHubJson,
  GITHUB_API_ORIGIN,
  isRecord,
  readOptionalGitHubString,
  readGitHubJsonResponse,
  resolveGitHubApiCredentialScope,
  requiredString,
} from "./control-ui-github-api.js";

const SEARCH_CACHE_MS = 60_000;
const SEARCH_CACHE_LIMIT = 100;
const SEARCH_RESULT_LIMIT = 10;
const AFFILIATED_RESULT_LIMIT = 10;
// GitHub owner/repo shapes; an exact match resolves directly instead of relying
// on search ranking (search tokenizes the slash and matches thousands of repos).
const EXACT_REPO_QUERY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

type SearchCacheEntry = {
  expiresAt: number;
  promise: Promise<ProjectsSearchRemoteResult>;
};

const searchCache = new Map<string, SearchCacheEntry>();

function boundedString(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseRepository(value: unknown): RemoteProject | null {
  if (!isRecord(value)) {
    return null;
  }
  let fullName: string;
  let name: string;
  try {
    fullName = requiredString(value, "full_name");
    name = requiredString(value, "name");
  } catch {
    return null;
  }
  const clone = parseProjectGitUrl(readOptionalGitHubString(value, "clone_url") ?? "");
  const webUrl = boundedString(readOptionalGitHubString(value, "html_url"), 2048);
  if (!clone || !webUrl) {
    return null;
  }
  const description = boundedString(readOptionalGitHubString(value, "description"), 500);
  return {
    name: name.slice(0, 100),
    fullName: fullName.slice(0, 200),
    cloneUrl: clone.url,
    webUrl,
    private: value.private === true,
    ...(description ? { description } : {}),
  };
}

function repositoryArray(value: unknown): RemoteProject[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  return items.flatMap((item) => {
    const parsed = parseRepository(item);
    return parsed ? [parsed] : [];
  });
}

function matchesAffiliatedQuery(project: RemoteProject, query: string): boolean {
  const needle = query.toLowerCase();
  return [project.name, project.fullName, project.description ?? ""]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

async function loadExactRepository(
  query: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<RemoteProject | null> {
  const url = new URL(`/repos/${query}`, GITHUB_API_ORIGIN);
  // Optional enrichment lane: a miss, API error, or transport rejection must
  // degrade to search-only results, never sink the whole picker query.
  try {
    return parseRepository(await fetchGitHubJson(url.href, fetchImpl, token));
  } catch {
    return null;
  }
}

async function loadAffiliatedRepositories(
  fetchImpl: typeof fetch,
  token: string,
): Promise<RemoteProject[]> {
  const url = new URL("/user/repos", GITHUB_API_ORIGIN);
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(AFFILIATED_RESULT_LIMIT));
  // Optional enrichment lane: see loadExactRepository — failures degrade to
  // global-search-only results instead of failing the picker query.
  try {
    const response = await fetchGitHubApi(url.href, fetchImpl, token);
    return repositoryArray(await readGitHubJsonResponse(response));
  } catch {
    return [];
  }
}

async function loadRepositorySearch(
  query: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<RemoteProject[]> {
  const url = new URL("/search/repositories", GITHUB_API_ORIGIN);
  url.searchParams.set("q", `${query} in:name,description`);
  url.searchParams.set("per_page", String(SEARCH_RESULT_LIMIT));
  return repositoryArray(await fetchGitHubJson(url.href, fetchImpl, token));
}

async function searchProjectsUncached(params: {
  query: string;
  fetchImpl: typeof fetch;
  token?: string;
}): Promise<ProjectsSearchRemoteResult> {
  const [exact, affiliated, global] = await Promise.all([
    EXACT_REPO_QUERY.test(params.query)
      ? loadExactRepository(params.query, params.fetchImpl, params.token)
      : null,
    params.token ? loadAffiliatedRepositories(params.fetchImpl, params.token) : [],
    loadRepositorySearch(params.query, params.fetchImpl, params.token),
  ]);
  // Order is the ranking: exact owner/name hit, then affiliated repositories
  // (API-sorted by recency), then global search in GitHub best-match order.
  const ranked = [
    ...(exact ? [exact] : []),
    ...affiliated.filter((project) => matchesAffiliatedQuery(project, params.query)),
    ...global,
  ];
  const deduped = new Map<string, RemoteProject>();
  for (const project of ranked) {
    const key = project.fullName.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, project);
    }
  }
  return {
    credential: params.token ? "configured" : "missing",
    projects: [...deduped.values()].slice(0, SEARCH_RESULT_LIMIT),
  };
}

/** Searches affiliated and public GitHub repositories for the project picker. */
export function searchRemoteProjects(
  query: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<ProjectsSearchRemoteResult> {
  const normalizedQuery = query.trim().toLowerCase();
  const { token, cacheScope } = resolveGitHubApiCredentialScope(options.env);
  // Gateway reloads run in-process, so cache results must stay credential-scoped.
  const cacheKey = `${normalizedQuery}\0${cacheScope}`;
  const now = options.now ?? Date.now();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, cached);
    return cached.promise;
  }
  const promise = searchProjectsUncached({
    query: query.trim(),
    fetchImpl: options.fetchImpl ?? fetch,
    token,
  }).catch((error: unknown) => {
    if (searchCache.get(cacheKey)?.promise === promise) {
      searchCache.delete(cacheKey);
    }
    throw error;
  });
  searchCache.set(cacheKey, { expiresAt: now + SEARCH_CACHE_MS, promise });
  pruneMapToMaxSize(searchCache, SEARCH_CACHE_LIMIT);
  return promise;
}
