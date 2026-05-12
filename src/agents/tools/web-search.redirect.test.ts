import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { withStrictWebToolsEndpointMock } = vi.hoisted(() => ({
  withStrictWebToolsEndpointMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  withStrictWebToolsEndpoint: withStrictWebToolsEndpointMock,
}));

let resolveCitationRedirectUrl: typeof import("./web-search-citation-redirect.js").resolveCitationRedirectUrl;

describe("web_search redirect resolution hardening", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ resolveCitationRedirectUrl } = await import("./web-search-citation-redirect.js"));
  });

  beforeEach(() => {
    withStrictWebToolsEndpointMock.mockReset();
  });

  it("resolves redirects via SSRF-guarded HEAD requests", async () => {
    withStrictWebToolsEndpointMock.mockImplementation(async (_params, run) => {
      return await run({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://example.com/final",
      });
    });

    const resolved = await resolveCitationRedirectUrl("https://example.com/start");
    expect(resolved).toBe("https://example.com/final");
    expect(withStrictWebToolsEndpointMock).toHaveBeenCalledTimes(1);
    const call = withStrictWebToolsEndpointMock.mock.calls.at(0) as
      | [{ url?: unknown; timeoutMs?: unknown; init?: { method?: unknown } }, unknown]
      | undefined;
    if (!call) {
      throw new Error("expected withStrictWebToolsEndpoint to be called");
    }
    const [params, run] = call;
    expect(params.url).toBe("https://example.com/start");
    expect(params.timeoutMs).toBe(5000);
    expect(params.init?.method).toBe("HEAD");
    expect(typeof run).toBe("function");
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    withStrictWebToolsEndpointMock.mockRejectedValue(new Error("blocked"));
    await expect(resolveCitationRedirectUrl("https://example.com/start")).resolves.toBe(
      "https://example.com/start",
    );
  });
});
