// Guard shared GitHub API helper tests cover transient-status retry behavior.
import { describe, expect, it } from "vitest";
import { createGitHubApi } from "../../scripts/github/guard-shared.mjs";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, statusText: string) {
  return new Response("Server Error", { status, statusText });
}

function apiWithResponses(responses: Response[], calls: { method?: string }[]) {
  const fetchImpl = (async (_url: string, init: { method?: string } = {}) => {
    calls.push({ method: init.method });
    const next = responses.shift();
    if (!next) throw new Error("fetch called more times than expected");
    return next;
  }) as unknown as typeof fetch;
  return createGitHubApi("token", {
    fetchImpl,
    retryDelaysMs: [0, 0, 0],
    userAgent: "test",
  });
}

describe("createGitHubApi transient status retries", () => {
  it("retries a GET that returns 500 and returns the eventual body", async () => {
    const calls: { method?: string }[] = [];
    const api = apiWithResponses(
      [errorResponse(500, "Internal Server Error"), jsonResponse({ ok: true })],
      calls,
    );

    await expect(api.request("/repos/o/r/pulls/1/files")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it.each([502, 503, 504])("keeps retrying a GET that returns %i", async (status) => {
    const calls: { method?: string }[] = [];
    const api = apiWithResponses(
      [errorResponse(status, "Bad Gateway"), jsonResponse({ ok: true })],
      calls,
    );

    await expect(api.request("/repos/o/r/pulls/1/files")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("gives up after the retry budget instead of retrying a 500 forever", async () => {
    const calls: { method?: string }[] = [];
    // One initial attempt plus retryDelaysMs.length retries, and no more.
    const api = apiWithResponses(
      Array.from({ length: 4 }, () => errorResponse(500, "Internal Server Error")),
      calls,
    );

    await expect(api.request("/repos/o/r/pulls/1/files")).rejects.toThrow("500");
    expect(calls).toHaveLength(4);
  });

  it("does not retry a POST that returns 500, since it is not idempotent", async () => {
    const calls: { method?: string }[] = [];
    const api = apiWithResponses([errorResponse(500, "Internal Server Error")], calls);

    await expect(
      api.request("/repos/o/r/issues/1/comments", { method: "POST", body: "{}" }),
    ).rejects.toThrow("500 Internal Server Error");
    expect(calls).toHaveLength(1);
  });

  it("still surfaces a status it must not retry, such as 404", async () => {
    const calls: { method?: string }[] = [];
    const api = apiWithResponses([errorResponse(404, "Not Found")], calls);

    await expect(api.request("/repos/o/r/pulls/1/files")).rejects.toThrow("404 Not Found");
    expect(calls).toHaveLength(1);
  });
});
