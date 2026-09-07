import { afterEach, describe, expect, it, vi } from "vitest";
import { searchRemoteProjects } from "./project-github-search.js";

function repository(fullName: string, updatedAt: string, description?: string) {
  const [owner, name] = fullName.split("/");
  return {
    id: fullName,
    name,
    full_name: fullName,
    private: false,
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    description: description ?? null,
    updated_at: updatedAt,
  };
}

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("project GitHub search", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns anonymous public results with a typed missing-credential state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        total_count: 1,
        incomplete_results: false,
        items: [repository("openclaw/openclaw", "2026-08-10T00:00:00Z")],
      }),
    );

    const result = await searchRemoteProjects("anonymous-openclaw", {
      env: {},
      fetchImpl,
      now: 100,
    });

    expect(result).toMatchObject({
      credential: "missing",
      projects: [{ fullName: "openclaw/openclaw" }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/search/repositories?");
  });

  it("prioritizes matching affiliated repositories and fills from global search", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json([
          repository("acme/matching-private", "2026-01-01T00:00:00Z", "configured-query"),
          repository("acme/unrelated", "2026-08-10T00:00:00Z"),
        ]),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            repository("acme/matching-private", "2026-08-11T00:00:00Z"),
            repository("public/configured-query", "2026-08-10T00:00:00Z"),
          ],
        }),
      );

    const result = await searchRemoteProjects("configured-query", {
      env: { GH_TOKEN: "test-github-token" },
      fetchImpl,
      now: 200,
    });

    expect(result).toEqual({
      credential: "configured",
      projects: [
        expect.objectContaining({ fullName: "acme/matching-private" }),
        expect.objectContaining({ fullName: "public/configured-query" }),
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/user/repos?");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer test-github-token",
    );
  });

  it("preserves GitHub best-match order for global results instead of re-sorting by recency", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        items: [
          repository("openclaw/best-match", "2020-01-01T00:00:00Z"),
          repository("someone/recently-pushed-fork", "2026-08-25T00:00:00Z"),
        ],
      }),
    );

    const result = await searchRemoteProjects("best-match", { env: {}, fetchImpl, now: 300 });

    expect(result.projects.map((project) => project.fullName)).toEqual([
      "openclaw/best-match",
      "someone/recently-pushed-fork",
    ]);
    const searchUrl = requestUrl(fetchImpl.mock.calls[0]?.[0]);
    expect(searchUrl).not.toContain("sort=");
  });

  it("resolves exact owner/name queries directly and ranks the repository first", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (requestUrl(input).includes("/repos/openclaw/openclaw")) {
        return json(repository("openclaw/openclaw", "2026-08-20T00:00:00Z"));
      }
      return json({
        items: [
          repository("someone/openclaw-tutorial", "2026-08-25T00:00:00Z"),
          repository("openclaw/openclaw", "2026-08-20T00:00:00Z"),
        ],
      });
    });

    const result = await searchRemoteProjects("openclaw/openclaw", {
      env: {},
      fetchImpl,
      now: 400,
    });

    expect(result.projects.map((project) => project.fullName)).toEqual([
      "openclaw/openclaw",
      "someone/openclaw-tutorial",
    ]);
    expect(fetchImpl.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      expect.stringContaining("/repos/openclaw/openclaw"),
      expect.stringContaining("/search/repositories?"),
    ]);
  });

  it("degrades to search results when the exact owner/name lookup misses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (requestUrl(input).includes("/repos/")) {
        return json({ message: "Not Found" }, 404);
      }
      return json({ items: [repository("acme/missing-exact", "2026-08-10T00:00:00Z")] });
    });

    const result = await searchRemoteProjects("acme/missing-exact-repo", {
      env: {},
      fetchImpl,
      now: 500,
    });

    expect(result.projects.map((project) => project.fullName)).toEqual(["acme/missing-exact"]);
  });

  it("degrades optional lanes to global results when their requests reject in transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/repos/") || url.includes("/user/repos")) {
        throw new TypeError("fetch failed");
      }
      return json({ items: [repository("acme/still-works", "2026-08-10T00:00:00Z")] });
    });

    const result = await searchRemoteProjects("acme/still-works", {
      env: { GH_TOKEN: "test-github-token" },
      fetchImpl,
      now: 600,
    });

    expect(result.projects.map((project) => project.fullName)).toEqual(["acme/still-works"]);
  });

  it("caches normalized queries for 60 seconds and refetches after expiry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json({ items: [repository("acme/cache-query", "2026-08-10")] }),
      );
    const options = { env: {}, fetchImpl, now: 1_000 };

    const first = await searchRemoteProjects("Cache-Query", options);
    const cached = await searchRemoteProjects(" cache-query ", { ...options, now: 60_999 });
    const refreshed = await searchRemoteProjects("cache-query", { ...options, now: 61_001 });

    expect(cached).toBe(first);
    expect(refreshed).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached results after the GitHub token rotates", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      return json({
        items: [
          repository(
            authorization === "Bearer github-token-a"
              ? "acme/token-rotation-a"
              : "acme/token-rotation-b",
            "2026-08-10T00:00:00Z",
          ),
        ],
      });
    });
    vi.stubEnv("GH_TOKEN", "github-token-a");
    vi.stubEnv("GITHUB_TOKEN", "");

    const first = await searchRemoteProjects("token-rotation", { fetchImpl, now: 70_000 });

    vi.stubEnv("GH_TOKEN", "github-token-b");
    const second = await searchRemoteProjects("token-rotation", { fetchImpl, now: 70_001 });

    expect(first.projects).toContainEqual(
      expect.objectContaining({ fullName: "acme/token-rotation-a" }),
    );
    expect(second.projects).toContainEqual(
      expect.objectContaining({ fullName: "acme/token-rotation-b" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
