// Control UI tests cover control ui e2e behavior.
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolvePlaywrightChromiumExecutablePath,
  systemChromiumExecutableCandidates,
  waitForControlUiRoute,
} from "./control-ui-e2e.ts";

describe("resolvePlaywrightChromiumExecutablePath", () => {
  it("uses a runnable system Chromium when the cached Playwright executable cannot start", () => {
    const systemExecutable = systemChromiumExecutableCandidates[1];

    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        {},
        (candidate) => candidate === systemExecutable,
      ),
    ).toBe(systemExecutable);
  });

  it("keeps explicit Chromium overrides authoritative", () => {
    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /custom/chromium " },
        () => false,
      ),
    ).toBe("/custom/chromium");
  });
});

describe("waitForControlUiRoute", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps polling while a new tab has no app element", async () => {
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      async waitForFunction(
        predicate: (target: { routeId: string }) => boolean,
        target: { routeId: string },
      ) {
        expect(predicate(target)).toBe(false);
        const app = document.createElement("openclaw-app");
        Object.assign(app, {
          runtime: {
            router: {
              getState: () => ({
                status: "success",
                resolvedLocation: { pathname: window.location.pathname },
                matches: [{ routeId: "chat" }],
                pendingMatches: [],
              }),
            },
          },
        });
        document.body.append(app);
        expect(predicate(target)).toBe(true);
        return { dispose: vi.fn() };
      },
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await waitForControlUiRoute(page, { routeId: "chat" });
  });

  it("preserves readiness failures when the app is still absent", async () => {
    const cause = new Error("Route readiness failed");
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      waitForFunction: vi.fn().mockRejectedValue(cause),
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await expect(waitForControlUiRoute(page, { routeId: "chat" })).rejects.toMatchObject({
      cause,
      message: expect.stringContaining('"router":null'),
    });
  });
});
