import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpElement: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(async () => "https://example.com"),
  fillChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async () => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: chromeMcpMocks.dragChromeMcpElement,
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: chromeMcpMocks.fillChromeMcpForm,
  hoverChromeMcpElement: chromeMcpMocks.hoverChromeMcpElement,
  pressChromeMcpKey: chromeMcpMocks.pressChromeMcpKey,
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const DEFAULT_SSRF_POLICY = { allowPrivateNetwork: false } as const;

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const routeState = existingSessionRouteState;

function getActPostHandler(
  ssrfPolicy: { allowPrivateNetwork: false } | null = DEFAULT_SSRF_POLICY,
) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({
      resolved: {
        evaluateEnabled: true,
        ssrfPolicy: ssrfPolicy ?? undefined,
      },
    }),
  } as never);
  const handler = postHandlers.get("/act");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("existing-session interaction navigation guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(chromeMcpMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(navigationGuardMocks)) {
      fn.mockClear();
    }
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com");
    routeState.profileCtx.listTabs.mockReset();
    routeState.profileCtx.listTabs.mockResolvedValue([
      {
        targetId: "7",
        url: "https://example.com",
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAction(
    body: Record<string, unknown>,
    ssrfPolicy: { allowPrivateNetwork: false } | null = DEFAULT_SSRF_POLICY,
  ) {
    const handler = getActPostHandler(ssrfPolicy);
    const response = createBrowserRouteResponse();
    const pending = handler?.({ params: {}, query: {}, body }, response.res);
    await vi.runAllTimersAsync();
    await pending;
    return response;
  }

  async function expectActionToReject(body: Record<string, unknown>) {
    await expectActionToThrow(body, "Unable to verify stable post-interaction navigation");
  }

  async function expectActionToThrow(body: Record<string, unknown>, message: string) {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const pending = handler?.({ params: {}, query: {}, body }, response.res) ?? Promise.resolve();
    void pending.catch(() => {});
    const completion = (async () => {
      await vi.runAllTimersAsync();
      await pending;
    })();

    await expect(completion).rejects.toThrow(message);
  }

  function expectNavigationProbeUrls(urls: string[]) {
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(
      urls.length,
    );
    for (const [index, url] of urls.entries()) {
      expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ url }),
      );
    }
  }

  it("checks navigation after click and key-driven submit paths", async () => {
    const clickResponse = await runAction({ kind: "click", ref: "btn-1" });
    const typeResponse = await runAction({
      kind: "type",
      ref: "field-1",
      text: "hello",
      submit: true,
    });

    expect(clickResponse.statusCode).toBe(200);
    expect(typeResponse.statusCode).toBe(200);
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter" }),
    );
    expectNavigationProbeUrls(Array.from({ length: 6 }, () => "https://example.com"));
  });

  it("rechecks the page url after delayed navigation-triggering interactions", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce(42 as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never);

    const response = await runAction({ kind: "evaluate", fn: "() => document.title" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(4);
    expectNavigationProbeUrls([
      "https://example.com",
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.169.254/latest/meta-data/",
    ]);
  });

  it("checks URLs for tabs opened during the interaction window", async () => {
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
      ])
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
        {
          targetId: "9",
          url: "http://169.254.169.254/latest/meta-data/",
        },
      ]);

    const response = await runAction({ kind: "click", ref: "btn-1" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "http://169.254.169.254/latest/meta-data/",
    ]);
  });

  it("fails closed when a newly opened tab URL is blocked", async () => {
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
      ])
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
        {
          targetId: "9",
          url: "http://169.254.169.254/latest/meta-data/",
        },
      ]);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        const url = opts?.url ?? "";
        if (url.includes("169.254.169.254")) {
          throw new Error("blocked new tab");
        }
      },
    );

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "blocked new tab");
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
  });

  it("fails closed when location probes never return a usable url", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce("   " as never);

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("fails closed when a later post-action probe becomes unreadable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce(undefined as never) // location probe 2 - unreadable
      .mockResolvedValueOnce(undefined as never) // location probe 3 - unreadable
      .mockResolvedValueOnce(undefined as never); // follow-up probe - still unreadable

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls(["https://example.com"]);
  });

  it("confirms stability via follow-up probe when URL changes on the last loop iteration", async () => {
    // Probe 1 (action evaluate result): returns the action value
    // Location probe 1 (0ms): fails (context churn)
    // Location probe 2 (250ms): reads safe URL A
    // Location probe 3 (500ms): reads safe URL B (late navigation)
    // Follow-up probe (500ms later): reads URL B again → stable, success
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockRejectedValueOnce(new Error("context churn") as never) // location probe 1 fails
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2: URL A
      .mockResolvedValueOnce("https://safe-redirect.com" as never) // location probe 3: URL B (changed)
      .mockResolvedValueOnce("https://safe-redirect.com" as never); // follow-up: URL B again → stable

    const response = await runAction({ kind: "evaluate", fn: "() => 1" });

    expect(response.statusCode).toBe(200);
    // 1 action call + 5 location probes (3 in loop + 1 failed + 1 follow-up)
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(5);
    expectNavigationProbeUrls([
      "https://example.com",
      "https://safe-redirect.com",
      "https://safe-redirect.com",
    ]);
  });

  it("keeps probing through the full window before declaring navigation stable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2
      .mockResolvedValueOnce("https://safe-redirect.com" as never) // location probe 3
      .mockResolvedValueOnce("https://safe-redirect.com" as never); // follow-up confirms late redirect

    const response = await runAction({ kind: "evaluate", fn: "() => 1" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(5);
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://safe-redirect.com",
      "https://safe-redirect.com",
    ]);
  });

  it("fails closed when follow-up probe sees yet another URL change", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://a.com" as never) // location probe 1
      .mockResolvedValueOnce("https://b.com" as never) // location probe 2: changed
      .mockResolvedValueOnce("https://c.com" as never) // location probe 3: changed again
      .mockResolvedValueOnce("https://d.com" as never); // follow-up: still changing

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
  });

  it("fails closed when a probe error follows two stable reads", async () => {
    // Probes 1 + 2 match (sawStableAllowedUrl would be true), probe 3 throws.
    // Guard must NOT return success — the throw invalidates prior stability.
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2 → stable pair
      .mockRejectedValueOnce(new Error("context destroyed") as never) // location probe 3 → error
      .mockRejectedValueOnce(new Error("context destroyed") as never); // follow-up → still errored

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls(["https://example.com", "https://example.com"]);
  });

  it("skips the guard when no SSRF policy is configured", async () => {
    const response = await runAction({ kind: "press", key: "Enter" }, null);

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expect(routeState.profileCtx.listTabs).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("still probes navigation when the interaction command throws", async () => {
    chromeMcpMocks.clickChromeMcpElement.mockImplementationOnce(() => {
      throw new Error("stale element");
    });

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "stale element");
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalled();
  });
});
