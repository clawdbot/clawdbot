import { describe, expect, it, vi } from "vitest";
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("project GitHub search", () => {
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
});
