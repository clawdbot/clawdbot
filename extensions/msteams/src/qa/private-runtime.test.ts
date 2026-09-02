import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMSTeamsPrivateQaRuntime } from "./private-runtime.js";

const completeEnv = {
  OPENCLAW_BUILD_PRIVATE_QA: "1",
};
const completeBootstrap = {
  connectorUrl: "http://127.0.0.1:43123/",
  nonce: "qa-nonce",
  botToken: "qa-bot-token",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Microsoft Teams private QA runtime", () => {
  it("leaves the production runtime unchanged without private QA inputs", () => {
    expect(resolveMSTeamsPrivateQaRuntime({})).toBeUndefined();
  });

  it("rejects private QA inputs outside the private QA build", () => {
    expect(() =>
      resolveMSTeamsPrivateQaRuntime(
        {
          ...completeEnv,
          OPENCLAW_BUILD_PRIVATE_QA: undefined,
        },
        completeBootstrap,
      ),
    ).toThrow("requires OPENCLAW_BUILD_PRIVATE_QA=1");
  });

  it.each(["connectorUrl", "nonce", "botToken"] as const)(
    "rejects a partial private QA bootstrap missing %s",
    (missing) => {
      expect(() =>
        resolveMSTeamsPrivateQaRuntime(
          {
            ...completeEnv,
          },
          {
            ...completeBootstrap,
            [missing]: undefined,
          },
        ),
      ).toThrow("bootstrap requires connector URL, nonce, and bot token");
    },
  );

  it("rejects a non-loopback connector", () => {
    expect(() =>
      resolveMSTeamsPrivateQaRuntime(completeEnv, {
        ...completeBootstrap,
        connectorUrl: "https://example.com/",
      }),
    ).toThrow("must use loopback HTTP");
  });

  it("returns a skip-auth runtime with the per-run token", async () => {
    const runtime = resolveMSTeamsPrivateQaRuntime(completeEnv, completeBootstrap);
    expect(runtime?.skipAuth).toBe(true);
    expect(runtime?.listenHost).toBe("127.0.0.1");
    await expect(runtime?.token()).resolves.toBe("qa-bot-token");
  });

  it("does not follow Connector redirects to another loopback origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://localhost:65535/internal" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = resolveMSTeamsPrivateQaRuntime(completeEnv, completeBootstrap);
    if (!runtime) {
      throw new Error("expected Microsoft Teams private QA runtime");
    }

    await expect(runtime.client.get("/v3/conversations/test/activities")).rejects.toThrow(
      "Too many redirects (limit: 0)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves Connector HTTP status for transport retry classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "gateway timeout" }, { status: 504 })),
    );
    const runtime = resolveMSTeamsPrivateQaRuntime(completeEnv, completeBootstrap);
    if (!runtime) {
      throw new Error("expected Microsoft Teams private QA runtime");
    }

    await expect(
      runtime.client.post("/v3/conversations/test/activities", {}),
    ).rejects.toMatchObject({ statusCode: 504 });
  });
});
