// Shared fixtures for the control-ui session PR tests; test-only module.
import { vi } from "vitest";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";

type GitContext = { owner: string; repo: string; branch: string };

export function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url ?? "";
}

export function routedFetch(
  routes: Array<{ match: string; response: () => Response | Promise<Response> }>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      throw new Error(`unexpected GitHub request: ${url}`);
    }
    return route.response();
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

export function pullListItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 103469,
    title: "fix(macos): tighten the link-browser tab header",
    html_url: "https://github.com/openclaw/openclaw/pull/103469",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: "a".repeat(40) },
    base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    ...overrides,
  };
}

export const testGitContext: GitContext = {
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
};

let cacheEvictionEpoch = 0;

// The module-level branch cache would leak entries across tests; flooding it
// past CACHE_LIMIT evicts everything a test created.
export async function evictPullRequestCache(): Promise<void> {
  const epoch = (cacheEvictionEpoch += 1);
  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:main" },
        {
          fetchImpl: async () => githubJson([]),
          resolveGitContext: async () => ({
            ...testGitContext,
            branch: `test/cache-eviction-${epoch}-${index}`,
          }),
        },
      ),
    ),
  );
}
