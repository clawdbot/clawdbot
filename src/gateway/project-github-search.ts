import type {
  RemoteProject,
  ProjectsSearchRemoteResult,
} from "../../packages/gateway-protocol/src/index.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { parseProjectGitUrl } from "../projects/project-git-url.js";
import {
  ControlUiGitHubError,
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

type SearchCandidate = {
  project: RemoteProject;
  affiliated: boolean;
  updatedAt: string;
};

type SearchCacheEntry = {
  expiresAt: number;
  promise: Promise<ProjectsSearchRemoteResult>;
};

const searchCache = new Map<string, SearchCacheEntry>();

function boundedString(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseRepository(value: unknown, affiliated: boolean): SearchCandidate | null {
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
  return {
    affiliated,
    updatedAt: readOptionalGitHubString(value, "updated_at") ?? "",
    project: {
      name: name.slice(0, 100),
      fullName: fullName.slice(0, 200),
      cloneUrl: clone.url,
      webUrl,
      private: value.private === true,
      ...(boundedString(readOptionalGitHubString(value, "description"), 500)
        ? { description: boundedString(readOptionalGitHubString(value, "description"), 500) }
        : {}),
    },
  };
}

function candidateSort(left: SearchCandidate, right: SearchCandidate): number {
  if (left.affiliated !== right.affiliated) {
    return left.affiliated ? -1 : 1;
  }
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  const leftName = left.project.fullName.toLowerCase();
  const rightName = right.project.fullName.toLowerCase();
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

function repositoryArray(value: unknown, affiliated: boolean): SearchCandidate[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  return items.flatMap((item) => {
    const parsed = parseRepository(item, affiliated);
    return parsed ? [parsed] : [];
  });
}

function matchesAffiliatedQuery(candidate: SearchCandidate, query: string): boolean {
  const needle = query.toLowerCase();
  return [candidate.project.name, candidate.project.fullName, candidate.project.description ?? ""]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

async function loadAffiliatedRepositories(
  fetchImpl: typeof fetch,
  token: string,
): Promise<SearchCandidate[]> {
  const url = new URL("/user/repos", GITHUB_API_ORIGIN);
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(AFFILIATED_RESULT_LIMIT));
  try {
    const response = await fetchGitHubApi(url.href, fetchImpl, token);
    return repositoryArray(await readGitHubJsonResponse(response), true);
  } catch (error) {
    if (error instanceof ControlUiGitHubError) {
      return [];
    }
    throw error;
  }
}

async function loadRepositorySearch(
  query: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<SearchCandidate[]> {
  const url = new URL("/search/repositories", GITHUB_API_ORIGIN);
  url.searchParams.set("q", `${query} in:name,description`);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(SEARCH_RESULT_LIMIT));
  return repositoryArray(await fetchGitHubJson(url.href, fetchImpl, token), false);
}

async function searchProjectsUncached(params: {
  query: string;
  fetchImpl: typeof fetch;
  token?: string;
}): Promise<ProjectsSearchRemoteResult> {
  const affiliated = params.token
    ? (await loadAffiliatedRepositories(params.fetchImpl, params.token)).filter((candidate) =>
        matchesAffiliatedQuery(candidate, params.query),
      )
    : [];
  const global = await loadRepositorySearch(params.query, params.fetchImpl, params.token);
  const deduped = new Map<string, SearchCandidate>();
  for (const candidate of [...affiliated, ...global].toSorted(candidateSort)) {
    const key = candidate.project.fullName.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, candidate);
    }
  }
  return {
    credential: params.token ? "configured" : "missing",
    projects: [...deduped.values()]
      .toSorted(candidateSort)
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((candidate) => candidate.project),
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
