import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { GitHubIdentityError } from "../agents/github-tool-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  setActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import { ControlUiGitHubError } from "./control-ui-github-api.js";
import {
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
} from "./control-ui-github-preview.js";

// List endpoints such as /pulls/{n}/commits return arrays, not objects.
function githubJson(body: unknown, status = 200): Response {
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
    expect(
      parseControlUiGitHubPreviewTarget({
        kind: "issue",
        number: 1,
        owner: "github",
        repo: ".github",
      }),
    ).toEqual({ kind: "issue", number: 1, owner: "github", repo: ".github" });
    for (const repo of [
      ".whitesource",
      ".emacs.d",
      "-edge",
      "_edge",
      "repo-",
      "repo.",
      "foo..bar",
    ]) {
      expect(
        parseControlUiGitHubPreviewTarget({
          kind: "issue",
          number: 1,
          owner: "openclaw",
          repo,
        }),
      ).toEqual({ kind: "issue", number: 1, owner: "openclaw", repo });
    }
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
    for (const repo of [".", "..", "repo.git", "repo.atom"]) {
      expect(
        parseControlUiGitHubPreviewTarget({
          kind: "issue",
          number: 1,
          owner: "openclaw",
          repo,
        }),
      ).toBeNull();
    }
  });
});

describe("loadControlUiGitHubPreview", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    setActiveDegradedSecretOwners([]);
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setActiveDegradedSecretOwners([]);
    vi.unstubAllEnvs();
  });

  it("keeps selected identity caches separate and revalidates cached delivery", async () => {
    const target = { kind: "issue" as const, number: 88122, owner: "openclaw", repo: "openclaw" };
    const makeIdentity = (token: string) => ({
      token,
      cacheScope: token,
      assertSelected: vi.fn(),
      revalidate: vi.fn().mockResolvedValue(undefined),
    });
    const firstIdentity = makeIdentity("first-preview-identity");
    const secondIdentity = makeIdentity("second-preview-identity");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) =>
      requestUrl(input).includes("/issues/")
        ? githubJson(
            previewPayload({
              user: {
                login:
                  new Headers(init?.headers).get("Authorization") ===
                  `Bearer ${firstIdentity.token}`
                    ? "first-account"
                    : "second-account",
              },
            }),
          )
        : githubJson({ private: false }),
    );

    const first = await loadControlUiGitHubPreview(target, firstIdentity, fetchMock);
    const second = await loadControlUiGitHubPreview(target, secondIdentity, fetchMock);
    expect(first.login).toBe("first-account");
    expect(second.login).toBe("second-account");
    expect(fetchMock).toHaveBeenCalledTimes(6);

    secondIdentity.revalidate.mockRejectedValue(new GitHubIdentityError("changed"));
    await expect(
      loadControlUiGitHubPreview(target, secondIdentity, fetchMock),
    ).rejects.toMatchObject({ reason: "changed" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    { stage: "repository", stopAfter: 1, redirect: false },
    { stage: "item", stopAfter: 2, redirect: false },
    { stage: "final visibility check", stopAfter: 3, redirect: false },
    { stage: "repository redirect", stopAfter: 1, redirect: true },
    { stage: "item redirect", stopAfter: 2, redirect: true },
    { stage: "commits redirect", stopAfter: 4, redirect: true },
  ])(
    "blocks later GitHub dispatches after identity changes during $stage",
    async ({ stopAfter, redirect, stage }) => {
      let changed = false;
      const assertSelected = () => {
        if (changed) {
          throw new GitHubIdentityError("changed");
        }
      };
      const identity = {
        token: "inflight-preview-identity",
        cacheScope: `inflight-preview-identity-${stage}`,
        assertSelected,
        revalidate: async () => assertSelected(),
      };
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = requestUrl(input);
        if (fetchMock.mock.calls.length === stopAfter) {
          changed = true;
          if (redirect) {
            return new Response(null, {
              status: 301,
              headers: { Location: url.replace("/openclaw/openclaw", "/openclaw/renamed") },
            });
          }
        }
        return githubJson(
          url.includes("/commits")
            ? []
            : url.includes("/pulls/")
              ? previewPayload({ user: { login: "octocat" } })
              : { private: false },
        );
      });
      await expect(
        loadControlUiGitHubPreview(
          { kind: "pull", number: 88123, owner: "openclaw", repo: "openclaw" },
          identity,
          fetchMock,
        ),
      ).rejects.toMatchObject({ reason: "changed" });
      expect(fetchMock).toHaveBeenCalledTimes(stopAfter);
    },
  );

  it("keeps concurrent readers and later cache hits independent of a disconnected caller", async () => {
    const started = createDeferred();
    const repository = createDeferred<Response>();
    let connected = true;
    const identity = {
      token: "shared-preview-identity",
      cacheScope: "shared-preview-identity",
      assertSelected() {
        if (!connected) {
          throw new GitHubIdentityError("changed");
        }
      },
      async revalidate() {
        this.assertSelected();
      },
    };
    const follower = {
      ...identity,
      assertSelected() {},
    };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (fetchMock.mock.calls.length === 1) {
        started.resolve();
        return repository.promise;
      }
      return githubJson(
        requestUrl(input).includes("/issues/")
          ? previewPayload({ user: { login: "octocat" } })
          : { private: false },
      );
    });
    const target = { kind: "issue" as const, number: 88125, owner: "openclaw", repo: "openclaw" };
    const first = loadControlUiGitHubPreview(target, identity, fetchMock);
    const rejected = expect(first).rejects.toMatchObject({ reason: "changed" });
    await started.promise;
    const second = loadControlUiGitHubPreview(target, follower, fetchMock);
    connected = false;
    repository.resolve(githubJson({ private: false }));
    await rejected;
    await expect(second).resolves.toMatchObject({ login: "octocat" });
    const calls = fetchMock.mock.calls.length;
    await expect(loadControlUiGitHubPreview(target, follower, fetchMock)).resolves.toMatchObject({
      login: "octocat",
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it.each([401, 403, 429])(
    "does not retry a selected identity failure anonymously (HTTP %s)",
    async (httpStatus) => {
      const identity = {
        token: "selected-preview-identity",
        cacheScope: `selected-preview-identity-${httpStatus}`,
        assertSelected: vi.fn(),
        revalidate: vi.fn().mockResolvedValue(undefined),
      };
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(githubJson({}, httpStatus));

      await expect(
        loadControlUiGitHubPreview(
          { kind: "issue", number: 88124, owner: "openclaw", repo: "openclaw" },
          identity,
          fetchMock,
        ),
      ).rejects.toMatchObject({ statusCode: httpStatus });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("normalizes public metadata and embeds a bounded GitHub avatar", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/commits")) {
        return githubJson([]);
      }
      if (url.includes("avatars.githubusercontent.com")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      }
      return githubJson(previewPayload());
    });
    const target = { kind: "pull" as const, number: 99816, owner: "openclaw", repo: "openclaw" };

    const first = await loadControlUiGitHubPreview(target, undefined, fetchMock);
    const second = await loadControlUiGitHubPreview(target, undefined, fetchMock);

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
    // Item, avatar, and the single commits page that carries co-author trailers.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/openclaw/openclaw/pulls/99816",
    );
    const avatarRequest = fetchMock.mock.calls
      .map(([input]) => input)
      .find((input) => {
        return input instanceof URL && input.href.includes("avatars.githubusercontent.com");
      });
    expect(avatarRequest).toBeInstanceOf(URL);
    expect(avatarRequest instanceof URL ? avatarRequest.href : "").toContain(
      "avatars.githubusercontent.com/u/58493",
    );
    expect(avatarRequest instanceof URL ? avatarRequest.hash : "").toBe("");
    expect(avatarRequest instanceof URL ? avatarRequest.search : "").toBe("?s=64");
    expect(avatarRequest instanceof URL ? avatarRequest.searchParams.get("s") : null).toBe("64");
  });

  it("resolves co-authors from noreply trailers without a lookup per person", async () => {
    const commits = [
      {
        commit: {
          message: "feat: one\n\nCo-authored-by: Ada King <20+ada@users.noreply.github.com>",
        },
      },
      // Repeat plus a different case: the same person must fold into one face.
      { commit: { message: "fix: two\n\nCo-authored-by: ada <20+ADA@users.noreply.github.com>" } },
      {
        commit: { message: "fix: three\n\nCo-authored-by: Mira <7+mira@users.noreply.github.com>" },
      },
      // The PR author is not their own co-author.
      {
        commit: {
          message:
            "fix: four\n\nCo-authored-by: steipete <58493+steipete@users.noreply.github.com>",
        },
      },
      // A plain address carries no account id, so it cannot resolve to a face.
      { commit: { message: "fix: five\n\nCo-authored-by: Someone <someone@example.com>" } },
    ];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/commits")) {
        return githubJson(commits);
      }
      if (url.includes("avatars.githubusercontent.com")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      }
      return githubJson(previewPayload());
    });

    const preview = await loadControlUiGitHubPreview(
      { kind: "pull", number: 88101, owner: "openclaw", repo: "openclaw" },
      undefined,
      fetchMock,
    );

    expect(preview.coAuthorCount).toBe(2);
    expect(preview.coAuthors).toEqual([
      { login: "ada", avatarDataUrl: "data:image/png;base64,iVBORw==" },
      { login: "mira", avatarDataUrl: "data:image/png;base64,iVBORw==" },
    ]);
    // The account id in the trailer is the avatar, so no per-person API lookup.
    const avatarUrls = fetchMock.mock.calls
      .map(([input]) => requestUrl(input))
      .filter((url) => url.includes("avatars.githubusercontent.com"));
    expect(avatarUrls).toEqual([
      "https://avatars.githubusercontent.com/u/58493?s=64",
      // Co-author avatars go through the same bounded ?s=64 normalization.
      "https://avatars.githubusercontent.com/u/20?s=64",
      "https://avatars.githubusercontent.com/u/7?s=64",
    ]);
  });

  it("keeps the card when the commits page fails and omits co-authors for issues", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/commits")) {
        return githubJson({ message: "rate limited" }, 403);
      }
      if (url.includes("avatars.githubusercontent.com")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      }
      return githubJson(previewPayload());
    });

    const pull = await loadControlUiGitHubPreview(
      { kind: "pull", number: 88102, owner: "openclaw", repo: "openclaw" },
      undefined,
      fetchMock,
    );

    expect(pull.login).toBe("steipete");
    expect(pull.coAuthors).toBeUndefined();
    expect(pull.coAuthorCount).toBeUndefined();

    fetchMock.mockClear();
    await loadControlUiGitHubPreview(
      { kind: "issue", number: 88103, owner: "openclaw", repo: "openclaw" },
      undefined,
      fetchMock,
    );

    // Issues have no commits, so they must not spend the extra request at all.
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/commits")),
    ).toHaveLength(0);
  });

  it("does not reuse cached previews after the GitHub credential scope changes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (!url.includes("/issues/")) {
        return githubJson({ private: false });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return githubJson(
        previewPayload({
          user: {
            login: authorization === "Bearer preview-token-a" ? "token-a" : "token-b",
          },
        }),
      );
    });
    const target = {
      kind: "issue" as const,
      number: 70013,
      owner: "openclaw",
      repo: "credential-scope",
    };
    vi.stubEnv("GH_TOKEN", "preview-token-a");

    const first = await loadControlUiGitHubPreview(target, undefined, fetchMock);
    vi.stubEnv("GH_TOKEN", "preview-token-b");
    const second = await loadControlUiGitHubPreview(target, undefined, fetchMock);

    expect(first.login).toBe("token-a");
    expect(second.login).toBe("token-b");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("revalidates configured credential availability before serving a cached preview", async () => {
    setRuntimeConfigSnapshot({
      gateway: { controlUi: { github: { token: "configured-preview-token" } } },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        requestUrl(input).includes("/issues/")
          ? githubJson(previewPayload({ user: { login: "cached-preview" } }))
          : githubJson({ private: false }),
      );
    const target = {
      kind: "issue" as const,
      number: 70014,
      owner: "openclaw",
      repo: "configured-degraded",
    };

    await loadControlUiGitHubPreview(target, undefined, fetchMock);
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        degradationState: "cold",
        paths: ["gateway.controlUi.github.token"],
        refKeys: ["store:default:PREVIEW_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);

    await expect(loadControlUiGitHubPreview(target, undefined, fetchMock)).rejects.toThrow(
      SecretSurfaceUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { avatarUrl: "https://example.com/avatar.png", number: 70001, repo: "avatar-host" },
    {
      avatarUrl: "https://avatars.githubusercontent.com/u/58493?v=4#fragment",
      number: 70002,
      repo: "avatar-fragment",
    },
    {
      avatarUrl: "https://avatars.githubusercontent.com/u/../58493?v=4",
      number: 70003,
      repo: "avatar-dot-segment",
    },
    {
      avatarUrl: "https://avatars.githubusercontent.com/u\\58493?v=4",
      number: 70004,
      repo: "avatar-backslash",
    },
  ])("does not fetch unsafe avatar URL $avatarUrl", async ({ avatarUrl, number, repo }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      githubJson(
        previewPayload({
          user: { avatar_url: avatarUrl, login: "octocat" },
        }),
      ),
    );

    const preview = await loadControlUiGitHubPreview(
      { kind: "issue", number, owner: "openclaw", repo },
      undefined,
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
      undefined,
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

    await loadControlUiGitHubPreview(target, undefined, fetchMock);

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

  it("retries stale optional authentication anonymously for public previews", async () => {
    vi.stubEnv("GH_TOKEN", "stale-github-token");
    let itemCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/commits")) {
        return githubJson([]);
      }
      itemCalls += 1;
      return itemCalls === 1
        ? githubJson({ message: "Bad credentials" }, 401)
        : githubJson(previewPayload({ user: { login: "octocat" } }));
    });

    const preview = await loadControlUiGitHubPreview(
      { kind: "pull", number: 70012, owner: "openclaw", repo: "openclaw" },
      undefined,
      fetchMock,
    );

    expect(preview.login).toBe("octocat");
    expect(itemCalls).toBe(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer stale-github-token",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
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
      undefined,
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
        undefined,
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 502 } satisfies Partial<ControlUiGitHubError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(requestUrl(fetchMock.mock.calls[1]?.[0])).origin).toBe("https://api.github.com");
    expect(redirectResponse.bodyUsed).toBe(true);
  });

  it("re-checks visibility when the commits request is redirected into another repository", async () => {
    vi.stubEnv("GH_TOKEN", "github-test-token");
    const visibilityChecks: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/repos/openclaw/openclaw")) {
        visibilityChecks.push(url);
        return githubJson({ private: false });
      }
      if (url.endsWith("/repos/openclaw/secret")) {
        visibilityChecks.push(url);
        // The token can read it; the Control UI viewer must not.
        return githubJson({ private: true });
      }
      if (url.includes("/commits")) {
        return new Response("moved", {
          status: 301,
          headers: {
            Location: "https://api.github.com/repos/openclaw/secret/pulls/88201/commits",
          },
        });
      }
      if (url.includes("avatars.githubusercontent.com")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      }
      return githubJson(previewPayload());
    });

    const preview = await loadControlUiGitHubPreview(
      { kind: "pull", number: 88201, owner: "openclaw", repo: "openclaw" },
      undefined,
      fetchMock,
    );

    // The card still renders; only the co-author decoration is withheld.
    expect(preview.login).toBe("steipete");
    expect(preview.coAuthors).toBeUndefined();
    // The redirect target was visibility-checked, and its commits were never fetched.
    expect(visibilityChecks).toContain("https://api.github.com/repos/openclaw/secret");
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).startsWith("https://api.github.com/repos/openclaw/secret/pulls"),
      ),
    ).toHaveLength(0);
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
        loadControlUiGitHubPreview(
          { kind: "issue", number, owner: "openclaw", repo },
          undefined,
          fetchMock,
        ),
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
        undefined,
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
      undefined,
      fetchMock,
    );
    await expect(
      loadControlUiGitHubPreview(
        { kind: "issue", number: 70006, owner: "openclaw", repo: "visibility-change" },
        undefined,
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
        undefined,
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
    expect(missingResponse.bodyUsed).toBe(true);
  });
});
