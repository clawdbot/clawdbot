import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleChatOutboundSessionRoute } from "./targets.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => ({
      response: await fetch(params.url, params.init),
      release: async () => {},
    }),
  ),
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: mocks.getGoogleChatAccessToken,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("./auth.js");
  vi.resetModules();
});

describe("outbound session routing", () => {
  it("reuses direct-message metadata for route classification", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ name: "spaces/DM-AAA", spaceType: "DIRECT_MESSAGE" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const route = await resolveGoogleChatOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "users/alice",
    });

    expect(route).toMatchObject({
      peer: { kind: "direct", id: "spaces/DM-AAA" },
      chatType: "direct",
      from: "googlechat:spaces/DM-AAA",
      to: "spaces/DM-AAA",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chat.googleapis.com/v1/spaces:findDirectMessage?name=users%2Falice",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
      },
    );
  });
});
