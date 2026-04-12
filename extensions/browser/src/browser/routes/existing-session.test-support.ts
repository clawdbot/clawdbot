import { vi } from "vitest";
import type { BrowserRequest } from "./types.js";

export const existingSessionRouteState = {
  profileCtx: {
    profile: {
      driver: "existing-session" as const,
      name: "chrome-live",
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "7",
      url: "https://example.com",
    })),
  },
  tab: {
    targetId: "7",
    url: "https://example.com",
  },
};

export function createExistingSessionAgentSharedModule() {
  return {
    getPwAiModule: vi.fn(async () => null),
    handleRouteError: vi.fn(),
    readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
    requirePwAi: vi.fn(async () => {
      throw new Error("Playwright should not be used for existing-session tests");
    }),
    resolveProfileContext: vi.fn(() => existingSessionRouteState.profileCtx),
    resolveTargetIdFromBody: vi.fn((body: Record<string, unknown>) =>
      typeof body.targetId === "string" ? body.targetId : undefined,
    ),
    withPlaywrightRouteContext: vi.fn(),
    withRouteTabContext: vi.fn(async ({ run }: { run: (args: unknown) => Promise<void> }) => {
      await run({
        profileCtx: existingSessionRouteState.profileCtx,
        cdpUrl: "http://127.0.0.1:18800",
        tab: existingSessionRouteState.tab,
      });
    }),
  };
}
