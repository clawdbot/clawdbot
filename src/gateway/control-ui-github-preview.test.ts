import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlUiGitHubError } from "./control-ui-github-api.js";
import {
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
} from "./control-ui-github-preview.js";

function githubJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url ?? "";
}

function previewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    additions: 101,
    changed_files: 3,
    closed_at: "2026-07-04T09:53:52Z",
    created_at: "2026-07-04T05:03:47Z",
    deletions: 12,
    draft: false,
    merged_at: "2026-07-04T09:53:52Z",
    state: "closed",
    title: "fix(agents): derive conversation scope from trusted group facts",
    updated_at: "2026-07-04T09:53:55Z",
    base: { repo: { url: "https://api.github.com/repos/openclaw/openclaw" } },
    repository_url: "https://api.github.com/repos/openclaw/openclaw",
    user: {
      avatar_url: "https://avatars.githubusercontent.com/u/58493?v=4",
      login: "steipete",
    },
    ...overrides,
  };
}

describe("parseControlUiGitHubPreviewTarget", () => {
  it("accepts bounded GitHub issue and pull request targets", () => {
    const target = parseControlUiGitHubPreviewTarget({
      kind: "pull",
      number: 99816,
      owner: "openclaw",
      repo: "openclaw",
    });
    expect(target).toEqual({ kind: "pull", number: 99816, owner: "openclaw", repo: "openclaw" });
  });

  it("rejects invalid repository paths and item numbers", () => {
    expect(
      parseControlUiGitHubPreviewTarget({
        kind: "issue",
        number: 1,
        owner: "openclaw/evil",
        repo: "openclaw",
      }),
    ).toBeNull();
    expect(
      parseControlUiGitHubPreviewTarget({
        kind: "issue",
        number: 0,
        owner: "openclaw",
        repo: "..",
      }),
    ).toBeNull();
  });
});

describe("loadControlUiGitHubPreview", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes public metadata and embeds a bounded GitHub avatar", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson(previewPayload()))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        }),
      );
    const target = { kind: "pull" as const, number: 99816, owner: "openclaw", repo: "openclaw" };

    const first = await loadControlUiGitHubPreview(target, fetchMock);
    const second = await loadControlUiGitHubPreview(target, fetchMock);

    expect(first).toMatchObject({
      additions: 101,
      avatarDataUrl: "data:image/png;base64,iVBORw==",
      changedFiles: 3,
      deletions: 12,
      kind: "pull",
      login: "steipete",
      mergedAt: "2026-07-04T09:53:52Z",
      number: 99816,
      owner: "openclaw",
      repo: "openclaw",
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/openclaw/openclaw/pulls/99816",
    );
    const avatarRequest = fetchMock.mock.calls[1]?.[0];
    expect(avatarRequest).toBeInstanceOf(URL);
    expect(avatarRequest instanceof URL ? avatarRequest.href : "").toContain(
      "avatars.githubusercontent.com/u/58493",
    );
    expect(avatarRequest instanceof URL ? avatarRequest.searchParams.get("s") : null).toBe("64");
  });

  it("does not fetch avatar URLs outside GitHub's avatar host", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      githubJson(
        previewPayload({
          user: { avatar_url: "https://example.com/avatar.png", login: "octocat" },
        }),
      ),
    );

    const preview = await loadControlUiGitHubPreview(
      { kind: "issue", number: 70001, owner: "openclaw", repo: "avatar-safety" },
      fetchMock,
    );

    expect(preview.avatarDataUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards rejected avatar response bodies", async () => {
    const avatarResponse = new Response("not an image", {
      headers: { "Content-Type": "text/plain" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson(previewPayload()))
      .mockResolvedValueOnce(avatarResponse);

    const preview = await loadControlUiGitHubPreview(
      { kind: "pull", number: 70009, owner: "openclaw", repo: "bad-avatar" },
      fetchMock,
    );

    expect(preview.avatarDataUrl).toBeUndefined();
    expect(avatarResponse.bodyUsed).toBe(true);
  });

  it("returns token-backed metadata only after public repository proofs", async () => {
    vi.stubEnv("GH_TOKEN", "github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson({ private: false }))
      .mockResolvedValueOnce(
        githubJson(
          previewPayload({
            repository_url: "https://api.github.com/repos/openclaw/public",
            user: { login: "octocat" },
          }),
        ),
      )
      .mockResolvedValueOnce(githubJson({ private: false }));
    const target = { kind: "issue" as const, number: 70003, owner: "openclaw", repo: "public" };

    await loadControlUiGitHubPreview(target, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/openclaw/public");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/openclaw/public/issues/70003",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.github.com/repos/openclaw/public");
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toHaveProperty("Authorization", "Bearer github-test-token");
    }
  });

  it("follows GitHub API redirects for renamed public repositories", async () => {
    vi.stubEnv("GH_TOKEN", "github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson({ private: false }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { Location: "/repos/openclaw/renamed/issues/70007" },
        }),
      )
      .mockResolvedValueOnce(githubJson({ private: false }))
      .mockResolvedValueOnce(
        githubJson(
          previewPayload({
            repository_url: "https://api.github.com/repos/openclaw/renamed",
            user: { login: "octocat" },
          }),
        ),
      )
      .mockResolvedValueOnce(githubJson({ private: false }));

    const preview = await loadControlUiGitHubPreview(
      { kind: "issue", number: 70007, owner: "openclaw", repo: "old-name" },
      fetchMock,
    );

    expect(preview.login).toBe("octocat");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(requestUrl(fetchMock.mock.calls[3]?.[0])).toBe(
      "https://api.github.com/repos/openclaw/renamed/issues/70007",
    );
    expect(requestUrl(fetchMock.mock.calls[4]?.[0])).toBe(
      "https://api.github.com/repos/openclaw/renamed",
    );
    for (const call of fetchMock.mock.calls) {
      expect(new URL(requestUrl(call[0])).origin).toBe("https://api.github.com");
      const headers = (call[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer github-test-token");
      expect(call[1]?.redirect).toBe("manual");
    }
  });

  it("rejects cross-origin GitHub API redirects before forwarding credentials", async () => {
    vi.stubEnv("GH_TOKEN", "github-test-token");
    const redirectResponse = new Response("discard me", {
      status: 301,
      headers: { Location: "https://example.com/repos/openclaw/private" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson({ private: false }))
      .mockResolvedValueOnce(redirectResponse);

    await expect(
      loadControlUiGitHubPreview(
        { kind: "pull", number: 70008, owner: "openclaw", repo: "unsafe-redirect" },
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 502 } satisfies Partial<ControlUiGitHubError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(requestUrl(fetchMock.mock.calls[1]?.[0])).origin).toBe("https://api.github.com");
    expect(redirectResponse.bodyUsed).toBe(true);
  });

  it("stops private and missing repositories before fetching item metadata", async () => {
    vi.stubEnv("GH_TOKEN", "github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson({ private: true }))
      .mockResolvedValueOnce(githubJson({ message: "Not Found" }, 404));

    for (const [repo, number] of [
      ["private", 70010],
      ["missing", 70011],
    ] as const) {
      await expect(
        loadControlUiGitHubPreview({ kind: "issue", number, owner: "openclaw", repo }, fetchMock),
      ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      "https://api.github.com/repos/openclaw/private",
      "https://api.github.com/repos/openclaw/missing",
    ]);
  });

  it("does not expose metadata transferred into a private repository", async () => {
    vi.stubEnv("GITHUB_TOKEN", "github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson({ private: false }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { Location: "/repos/openclaw/private/issues/70004" },
        }),
      )
      .mockResolvedValueOnce(githubJson({ private: true }));

    await expect(
      loadControlUiGitHubPreview(
        { kind: "issue", number: 70004, owner: "openclaw", repo: "public-source" },
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer github-test-token",
    );
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer github-test-token",
    );
  });

  it("rechecks public visibility for every authenticated preview cache miss", async () => {
    vi.stubEnv("GH_TOKEN", "github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson({ private: false }))
      .mockResolvedValueOnce(
        githubJson(
          previewPayload({
            repository_url: "https://api.github.com/repos/openclaw/visibility-change",
            user: { login: "octocat" },
          }),
        ),
      )
      .mockResolvedValueOnce(githubJson({ private: false }))
      .mockResolvedValueOnce(githubJson({ private: true }));

    await loadControlUiGitHubPreview(
      { kind: "issue", number: 70005, owner: "openclaw", repo: "visibility-change" },
      fetchMock,
    );
    await expect(
      loadControlUiGitHubPreview(
        { kind: "issue", number: 70006, owner: "openclaw", repo: "visibility-change" },
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("maps missing GitHub items to a safe not-found error", async () => {
    const missingResponse = githubJson({ message: "Not Found" }, 404);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(missingResponse);

    await expect(
      loadControlUiGitHubPreview(
        { kind: "issue", number: 70002, owner: "openclaw", repo: "missing-preview" },
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
    expect(missingResponse.bodyUsed).toBe(true);
  });
});
