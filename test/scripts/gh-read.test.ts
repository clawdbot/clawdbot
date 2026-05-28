import { describe, expect, it } from "vitest";
import {
  buildReadPermissions,
  githubJson,
  normalizeRepo,
  parsePermissionKeys,
  parseRepoArg,
  readBoundedGitHubErrorText,
  resolveGitHubFetchTimeoutMs,
} from "../../scripts/gh-read.js";

describe("gh-read helpers", () => {
  it("finds repo from gh args", () => {
    expect(parseRepoArg(["pr", "view", "42", "-R", "openclaw/openclaw"])).toBe("openclaw/openclaw");
    expect(parseRepoArg(["run", "list", "--repo=openclaw/docs"])).toBe("openclaw/docs");
    expect(parseRepoArg(["pr", "view", "42"])).toBeNull();
  });

  it("normalizes repo strings from common git formats", () => {
    expect(normalizeRepo("openclaw/openclaw")).toBe("openclaw/openclaw");
    expect(normalizeRepo("github.com/openclaw/openclaw")).toBe("openclaw/openclaw");
    expect(normalizeRepo("https://github.com/openclaw/openclaw.git")).toBe("openclaw/openclaw");
    expect(normalizeRepo("git@github.com:openclaw/openclaw.git")).toBe("openclaw/openclaw");
    expect(normalizeRepo("invalid")).toBeNull();
  });

  it("builds a read-only permission subset from granted permissions", () => {
    expect(
      buildReadPermissions(
        {
          actions: "write",
          issues: "read",
          administration: "write",
          metadata: "read",
          statuses: null,
        },
        ["actions", "issues", "metadata", "statuses", "administration"],
      ),
    ).toEqual({
      administration: "read",
      actions: "read",
      issues: "read",
      metadata: "read",
    });
  });

  it("parses permission key overrides", () => {
    expect(parsePermissionKeys(undefined)).toContain("pull_requests");
    expect(parsePermissionKeys("actions, contents ,issues")).toEqual([
      "actions",
      "contents",
      "issues",
    ]);
  });

  it("aborts stalled GitHub API fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = githubJson("/app", "token", undefined, {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/GitHub API GET \/app exceeded timeout/u);
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled GitHub API response body reads", async () => {
    const response = {
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    } as Response;
    const request = githubJson("/app/installations", "token", undefined, {
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/GitHub API GET \/app\/installations exceeded timeout/u);
  });

  it("bounds GitHub API error response bodies", async () => {
    const tail = "tail-sentinel-should-not-appear";
    const response = new Response(`${"x".repeat(5000)}${tail}`, {
      status: 500,
    });

    const text = await readBoundedGitHubErrorText(response);

    expect(text).toContain("[truncated]");
    expect(text).not.toContain(tail);
    expect(text.length).toBeLessThan(4200);
  });

  it("rejects invalid GitHub API timeout values", () => {
    expect(resolveGitHubFetchTimeoutMs("1000")).toBe(1000);
    expect(() => resolveGitHubFetchTimeoutMs("1s")).toThrow(
      /OPENCLAW_GH_READ_FETCH_TIMEOUT_MS must be an integer/u,
    );
  });
});
