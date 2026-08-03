/**
 * Test support for existing-session browser route modules.
 *
 * Supplies mocked agent.shared helpers and mutable tab/profile state for route
 * tests that exercise Chrome MCP branches without launching Chrome.
 */
import { vi } from "vitest";
import {
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";

/** Mutable profile/tab state consumed by existing-session route mocks. */
export const existingSessionRouteState = {
  profileCtx: {
    profile: {
      driver: "existing-session" as const,
      name: "chrome-live",
    },
    listTabs: vi.fn(async () => [
      {
        targetId: "7",
        url: "https://example.com",
      },
    ]),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "7",
      url: "https://example.com",
    })),
    closeTab: vi.fn(async () => {}),
  },
  tab: {
    targetId: "7",
    url: "https://example.com",
  },
};

/** Create a vi mock module for routes that import agent.shared helpers. */
export function createExistingSessionAgentSharedModule() {
  return {
    browserNavigationPolicyForProfile: vi.fn((ctx: BrowserRouteContext) =>
      withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy),
    ),
    getPwAiModule: vi.fn(async () => null),
    handleRouteError: vi.fn((_ctx: BrowserRouteContext, res: BrowserResponse, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400);
      res.json({ error: message });
    }),
    readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
    requirePwAi: vi.fn(async () => {
      throw new Error("Playwright should not be used for existing-session tests");
    }),
    resolveProfileContext: vi.fn(() => existingSessionRouteState.profileCtx),
    resolveSafeRouteTabUrl: vi.fn(
      async (params: {
        profileCtx: typeof existingSessionRouteState.profileCtx;
        targetId: string;
        fallbackUrl?: string;
      }) => {
        const tabs = await params.profileCtx.listTabs();
        return tabs.find((tab) => tab.targetId === params.targetId)?.url ?? params.fallbackUrl;
      },
    ),
    resolveTargetIdFromBody: vi.fn((body: Record<string, unknown>) =>
      typeof body.targetId === "string" ? body.targetId : undefined,
    ),
    withPlaywrightRouteContext: vi.fn(),
    withRouteTabContext: vi.fn(
      async ({
        ctx,
        enforceCurrentUrlAllowed,
        req,
        run,
      }: {
        ctx: BrowserRouteContext;
        enforceCurrentUrlAllowed?: boolean;
        req: BrowserRequest;
        run: (args: unknown) => Promise<void>;
      }) => {
        if (enforceCurrentUrlAllowed) {
          const ssrfPolicyOpts = withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy);
          if (ssrfPolicyOpts.ssrfPolicy) {
            await assertBrowserNavigationResultAllowed({
              url: existingSessionRouteState.tab.url,
              ...ssrfPolicyOpts,
            });
          }
        }
        await run({
          profileCtx: existingSessionRouteState.profileCtx,
          cdpUrl: "http://127.0.0.1:18800",
          tab: existingSessionRouteState.tab,
          signal: req.signal ?? new AbortController().signal,
          resolveTabUrl: vi.fn(async (fallbackUrl?: string) => fallbackUrl ?? routeStateUrl()),
        });
      },
    ),
  };
}

function routeStateUrl() {
  return existingSessionRouteState.tab.url;
}
