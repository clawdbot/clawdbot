import { describe, expect, it, vi } from "vitest";
import { ControlUiGitHubError } from "./control-ui-github-api.js";
import { resolveGitHubUserIdentity } from "./github-user-identity.js";

function githubResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("resolveGitHubUserIdentity", () => {
  it("resolves the canonical public account without authentication", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(githubResponse({ id: 583231, login: "OctoCat" }));

    await expect(resolveGitHubUserIdentity("octocat", fetchMock)).resolves.toEqual({
      accountId: 583231,
      login: "OctoCat",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/users/octocat",
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenClaw-Control-UI",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(headers).not.toHaveProperty("Authorization");
  });

  it.each([
    {
      name: "not found",
      response: githubResponse({ message: "Not Found" }, 404),
      statusCode: 404,
    },
    {
      name: "rate limited",
      response: githubResponse({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
      statusCode: 429,
    },
    { name: "malformed", response: githubResponse({ id: "583231" }), statusCode: 502 },
  ])("maps a $name response", async ({ response, statusCode }) => {
    await expect(
      resolveGitHubUserIdentity("octocat", vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).rejects.toMatchObject({ statusCode } satisfies Partial<ControlUiGitHubError>);
  });

  it("maps network failures and rejects invalid usernames before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));
    await expect(resolveGitHubUserIdentity("octocat", fetchMock)).rejects.toMatchObject({
      statusCode: 502,
    } satisfies Partial<ControlUiGitHubError>);
    await expect(resolveGitHubUserIdentity("bad/name", fetchMock)).rejects.toThrow(
      "GitHub username is invalid",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
