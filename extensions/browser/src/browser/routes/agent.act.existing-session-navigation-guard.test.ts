// Browser tests cover agent.act.existing session navigation guard plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMocks = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async () => {}),
  clickChromeMcpElement: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(async (_params: unknown) => "https://example.com"),
  fillChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async () => {}),
  withChromeMcpDocument: vi.fn(
    async (_params: unknown, task: (document: { evaluate: (fn: string) => unknown }) => unknown) =>
      await task({
        evaluate: async (fn) =>
          fn.includes("globalThis.location.href")
            ? "https://example.com"
            : { kind: "result", ready: true },
      }),
  ),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  ChromeMcpDocumentUnavailableError: chromeMcpMocks.ChromeMcpDocumentUnavailableError,
  clickChromeMcpCoords: chromeMcpMocks.clickChromeMcpCoords,
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: chromeMcpMocks.dragChromeMcpElement,
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: chromeMcpMocks.fillChromeMcpForm,
  hoverChromeMcpElement: chromeMcpMocks.hoverChromeMcpElement,
  pressChromeMcpKey: chromeMcpMocks.pressChromeMcpKey,
  resizeChromeMcpPage: vi.fn(async () => {}),
  withChromeMcpDocument: chromeMcpMocks.withChromeMcpDocument,
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const DEFAULT_SSRF_POLICY = { allowPrivateNetwork: false } as const;
const GUARDED_TARGET_REFRESH_ACTIONS = [
  { kind: "hover", ref: "btn-1" },
  { kind: "scrollIntoView", ref: "btn-1" },
  { kind: "drag", startRef: "item-1", endRef: "slot-1" },
  { kind: "select", ref: "menu-1", values: ["alpha"] },
  { kind: "fill", fields: [{ ref: "input-1", value: "Ada" }] },
  { kind: "evaluate", fn: "() => document.title" },
] as const;

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const routeState = existingSessionRouteState;

function getActPostHandler(
  ssrfPolicy: { allowPrivateNetwork: false } | null = DEFAULT_SSRF_POLICY,
) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
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
      if ("mockClear" in fn) {
        fn.mockClear();
      }
    }
    for (const fn of Object.values(navigationGuardMocks)) {
      fn.mockClear();
    }
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
    );
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com");
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(
      async (
        _params: unknown,
        task: (document: { evaluate: (fn: string) => unknown }) => unknown,
      ) =>
        await task({
          evaluate: async (fn) =>
            fn.includes("globalThis.location.href")
              ? "https://example.com"
              : { kind: "result", ready: true },
        }),
    );
    routeState.tab.url = "https://example.com";
    routeState.profileCtx.closeTab.mockReset();
    routeState.profileCtx.closeTab.mockResolvedValue(undefined);
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
      expect(
        navigationGuardMocks.assertBrowserNavigationResultAllowed.mock.calls[index]?.[0]?.url,
      ).toBe(url);
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
    expectNavigationProbeUrls(Array.from({ length: 8 }, () => "https://example.com"));
  });

  it("checks the bound document URL before evaluating a wait predicate", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("https://example.com")
      .mockResolvedValueOnce({ kind: "result", ready: true });
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const response = await runAction({ kind: "wait", fn: "() => document.title === 'ready'" });

    expect(response.statusCode).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed.mock.calls[0]?.[0]?.url).toBe(
      "https://example.com",
    );
    expect(String(evaluate.mock.calls[1]?.[0])).toContain("document.title === 'ready'");
  });

  it("preserves promise-returning predicates inside the bound document", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("https://example.com")
      .mockResolvedValueOnce({ kind: "result", ready: true });
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const response = await runAction({ kind: "wait", fn: "() => Promise.resolve(true)" });

    expect(response.statusCode).toBe(200);
    const script = String(evaluate.mock.calls[1]?.[0]);
    expect(script).toContain("Boolean(await");
    expect(routeState.profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it("does not run a wait predicate in a document rejected by navigation policy", async () => {
    const evaluate = vi.fn().mockResolvedValue("http://169.254.169.254/latest/meta-data");
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );
    navigationGuardMocks.assertBrowserNavigationResultAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("blocked document"));

    await expectActionToThrow({ kind: "wait", fn: "() => document.cookie" }, "blocked document");

    expect(evaluate).toHaveBeenCalledOnce();
    expect(String(evaluate.mock.calls[0]?.[0])).not.toContain("document.cookie");
  });

  it("rechecks a requested URL after a ready predicate mutates same-document history", async () => {
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(async (_params, task) => {
      let urlReads = 0;
      return await task({
        evaluate: async (fn) => {
          if (!fn.includes("globalThis.location.href")) {
            return { kind: "result", ready: true };
          }
          urlReads += 1;
          if (urlReads === 2) {
            throw new Error("final URL rechecked");
          }
          return "https://example.com/ready";
        },
      });
    });

    await expectActionToThrow(
      {
        kind: "wait",
        url: "https://example.com/ready",
        fn: "() => { history.pushState({}, '', '/changed'); return true; }",
      },
      "final URL rechecked",
    );
  });

  it.each(GUARDED_TARGET_REFRESH_ACTIONS)(
    "resolves current target after guarded $kind interaction",
    async (body) => {
      routeState.profileCtx.listTabs
        .mockResolvedValueOnce([routeState.tab])
        .mockResolvedValue([{ targetId: "new-target", url: routeState.tab.url }]);

      const response = await runAction(body);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        targetId: "new-target",
        url: routeState.tab.url,
      });
    },
  );

  it("threads one request budget through coordinate actions and navigation probes", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();
    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { kind: "clickCoords", x: 20, y: 30 },
        signal: ctrl.signal,
      },
      response.res,
    );

    await vi.runAllTimersAsync();
    await pending;

    const expectedOptions = { signal: ctrl.signal, timeoutMs: 60_000 };
    expect(chromeMcpMocks.clickChromeMcpCoords).toHaveBeenCalledWith(
      expect.objectContaining(expectedOptions),
    );
    for (const [params] of chromeMcpMocks.evaluateChromeMcpScript.mock.calls) {
      expect(params).toEqual(expect.objectContaining(expectedOptions));
    }
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledWith(expectedOptions);
  });

  it("cancels a pending existing-session wait when its request aborts", async () => {
    const handler = getActPostHandler(null);
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();
    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", timeMs: 30_000 },
        signal: ctrl.signal,
      },
      response.res,
    );
    void pending?.catch(() => {});

    ctrl.abort(new Error("request cancelled after browser crash"));

    await expect(pending).rejects.toThrow(/aborted|cancelled/i);
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
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
      "https://example.com",
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.169.254/latest/meta-data/",
    ]);
  });

  it("normalizes statement-body evaluate sources before Chrome MCP execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(42 as never);

    const response = await runAction(
      { kind: "evaluate", fn: "const value = 41; return value + 1;" },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        fn: "async () => {\nconst value = 41; return value + 1;\n}",
      }),
    );
  });

  it("forwards evaluate timeoutMs to Chrome MCP existing-session execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(42 as never);

    const response = await runAction(
      { kind: "evaluate", fn: "() => 1 + 1", timeoutMs: 60_000 },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        fn: "() => 1 + 1",
        timeoutMs: 60_000,
      }),
    );
  });

  it("normalizes ref-scoped statement-body evaluate sources before Chrome MCP execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce("Ada" as never);

    const response = await runAction(
      { kind: "evaluate", ref: "7", fn: "const text = el.textContent; return text;" },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["7"],
        fn: "async (el) => {\nconst text = el.textContent; return text;\n}",
      }),
    );
  });

  it("blocks evaluate before execution when the current tab URL is disallowed", async () => {
    routeState.tab.url = "http://169.254.169.254/latest/meta-data/";
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        const url = opts?.url ?? "";
        if (url.includes("169.254.169.254")) {
          throw new Error("blocked current tab");
        }
      },
    );

    await expectActionToThrow(
      { kind: "evaluate", fn: "() => document.body.innerText" },
      "blocked current tab",
    );
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expectNavigationProbeUrls(["http://169.254.169.254/latest/meta-data/"]);
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
    expectNavigationProbeUrls(["https://example.com"]);
  });

  it("fails closed when a later post-action probe becomes unreadable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce(undefined as never) // location probe 2 - unreadable
      .mockResolvedValueOnce(undefined as never) // location probe 3 - unreadable
      .mockResolvedValueOnce(undefined as never); // follow-up probe - still unreadable

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls(["https://example.com", "https://example.com"]);
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
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
    ]);
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
