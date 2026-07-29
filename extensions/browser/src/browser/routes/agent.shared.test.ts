// Browser tests cover agent.shared plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { BrowserProfileUnavailableError, toBrowserErrorResponse } from "../errors.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import "../../test-support/browser-security.mock.js";
import {
  readBody,
  handleRouteError,
  resolveSafeRouteTabUrl,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  withRouteTabContext,
} from "./agent.shared.js";
import { createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

function requestWithBody(body: unknown): BrowserRequest {
  return {
    params: {},
    query: {},
    body,
  };
}

function routeContext(ssrfPolicy?: unknown) {
  return {
    state: () => ({
      resolved: {
        extraArgs: [],
        ssrfPolicy,
      },
    }),
  };
}

function profileContext(tabs: Array<{ targetId: string; url: string }>) {
  return {
    profile: {
      cdpIsLoopback: true,
      driver: "openclaw",
    },
    listTabs: async () => tabs,
  };
}

function routeContextForTab(
  url: string,
  ensureTabAvailable = vi.fn(async () => ({
    targetId: "tab-1",
    title: "Tab",
    url,
    type: "page",
  })),
): BrowserRouteContext {
  const profileCtx = {
    profile: {
      cdpUrl: "http://127.0.0.1:9222",
      name: "default",
    },
    ensureTabAvailable,
  } as unknown as ProfileContext;

  return {
    forProfile: () => profileCtx,
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        ssrfPolicy: {},
      },
    }),
    mapTabError: () => null,
  } as unknown as BrowserRouteContext;
}

describe("browser route shared helpers", () => {
  it("preserves structured browser errors on agent routes", () => {
    const response = createBrowserRouteResponse();
    const error = new BrowserProfileUnavailableError("display required", {
      metadata: {
        reason: "no_display_for_headed_profile",
        details: {
          profile: "openclaw",
          requestedHeadless: false,
          headlessSource: "env",
          displayPresent: false,
        },
      },
    });

    handleRouteError({ mapTabError: toBrowserErrorResponse } as never, response.res, error);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      error: "display required",
      reason: "no_display_for_headed_profile",
      details: { headlessSource: "env" },
    });
  });

  it("redacts credentials from unmapped route errors", () => {
    const response = createBrowserRouteResponse();
    const error = new Error(
      "connect failed for wss://browser-user:browser-password@browserless.example/cdp?token=browser-token",
    );

    handleRouteError({ mapTabError: () => null } as never, response.res, error);

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ error: expect.stringContaining("browserless.example") });
    expect(JSON.stringify(response.body)).not.toContain("browser-user");
    expect(JSON.stringify(response.body)).not.toContain("browser-password");
    expect(JSON.stringify(response.body)).not.toContain("browser-token");
  });

  describe("readBody", () => {
    it("returns object bodies", () => {
      expect(readBody(requestWithBody({ one: 1 }))).toEqual({ one: 1 });
    });

    it("normalizes non-object bodies to empty object", () => {
      expect(readBody(requestWithBody(null))).toStrictEqual({});
      expect(readBody(requestWithBody("text"))).toStrictEqual({});
      expect(readBody(requestWithBody(["x"]))).toStrictEqual({});
    });
  });

  describe("target id parsing", () => {
    it("extracts and trims targetId from body", () => {
      expect(resolveTargetIdFromBody({ targetId: "  tab-1  " })).toBe("tab-1");
      expect(resolveTargetIdFromBody({ targetId: "   " })).toBeUndefined();
      expect(resolveTargetIdFromBody({ targetId: 123 })).toBeUndefined();
    });

    it("extracts and trims targetId from query", () => {
      expect(resolveTargetIdFromQuery({ targetId: "  tab-2  " })).toBe("tab-2");
      expect(resolveTargetIdFromQuery({ targetId: "" })).toBeUndefined();
      expect(resolveTargetIdFromQuery({ targetId: false })).toBeUndefined();
    });
  });

  describe("safe route tab URLs", () => {
    it("returns the current listed URL for a tab target", async () => {
      await expect(
        resolveSafeRouteTabUrl({
          ctx: routeContext() as never,
          profileCtx: profileContext([
            { targetId: "tab-1", url: "https://example.com/current" },
          ]) as never,
          targetId: "tab-1",
          fallbackUrl: "https://example.com/stale",
        }),
      ).resolves.toBe("https://example.com/current");
    });

    it("falls back to the ensured tab URL when tab listing is stale", async () => {
      await expect(
        resolveSafeRouteTabUrl({
          ctx: routeContext() as never,
          profileCtx: profileContext([]) as never,
          targetId: "tab-1",
          fallbackUrl: "https://example.com/fallback",
        }),
      ).resolves.toBe("https://example.com/fallback");
    });

    it("omits URLs blocked by the browser SSRF policy", async () => {
      await expect(
        resolveSafeRouteTabUrl({
          ctx: routeContext({ dangerouslyAllowPrivateNetwork: false }) as never,
          profileCtx: profileContext([
            { targetId: "tab-1", url: "http://127.0.0.1:9222/" },
          ]) as never,
          targetId: "tab-1",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("withRouteTabContext", () => {
    it("opts agent routes into Playwright target-id fallback", async () => {
      const response = createBrowserRouteResponse();
      const ensureTabAvailable = vi.fn(async () => ({
        targetId: "tab-1",
        title: "Tab",
        url: "https://example.com",
        type: "page",
      }));

      await withRouteTabContext({
        req: requestWithBody({}),
        res: response.res,
        ctx: routeContextForTab("https://example.com", ensureTabAvailable),
        run: async () => {},
      });

      expect(ensureTabAvailable).toHaveBeenCalledWith(undefined, {
        allowPlaywrightFallback: true,
        signal: expect.any(AbortSignal),
        timeoutMs: 60_000,
      });
    });

    it("does not enforce current-tab URL policy unless requested", async () => {
      const response = createBrowserRouteResponse();
      const run = vi.fn(async () => {
        response.res.json({ ok: true });
      });

      await withRouteTabContext({
        req: requestWithBody({}),
        res: response.res,
        ctx: routeContextForTab("http://127.0.0.1:8080/admin"),
        run,
      });

      expect(run).toHaveBeenCalledOnce();
      expect(response.body).toEqual({ ok: true });
    });

    it("blocks guarded routes before running on a disallowed current tab", async () => {
      const response = createBrowserRouteResponse();
      const run = vi.fn(async () => {
        response.res.json({ ok: true });
      });

      await withRouteTabContext({
        req: requestWithBody({}),
        res: response.res,
        ctx: routeContextForTab("http://127.0.0.1:8080/admin"),
        enforceCurrentUrlAllowed: true,
        run,
      });

      expect(run).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(400);
      const body = response.body as { error?: unknown };
      expect(typeof body.error).toBe("string");
      expect(body.error).not.toBe("");
    });
  });
});
