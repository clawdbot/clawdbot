import { expect, it } from "vitest";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const MAIN_KEY = "agent:main:main";
const RESEARCH_KEY = "agent:main:research";

function sessionsMock() {
  return {
    methodResponses: {
      "sessions.list": sessionsListResponse([
        sessionRow(MAIN_KEY, "Main", Date.parse("2026-07-01T16:00:00.000Z")),
        sessionRow(RESEARCH_KEY, "Research notes", Date.parse("2026-07-01T15:00:00.000Z")),
      ]),
      "sessions.patch": {},
    },
    sessionKey: MAIN_KEY,
  } as const;
}

suite.define(() => {
  it("keeps the sidebar on a bare /chat first load", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, sessionsMock());
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      // The general chat surface is the app's main view; collapsing it here
      // would be a default-path regression, so this is the guard for it.
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await captureUiProof(page, "per-tab-01-chat-root-sidebar-visible.png");
    } finally {
      await context.close();
    }
  });

  it("collapses the sidebar for a tab opened directly on one conversation, and Cmd+B restores it", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, sessionsMock());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, RESEARCH_KEY));
      const sidebar = page.locator("openclaw-app-sidebar");
      const expandButton = page.locator(".shell-chrome-controls__nav-toggle");
      const composer = page.getByPlaceholder("Message OpenClaw");
      await expandButton.waitFor({ state: "visible", timeout: 10_000 });
      // Wait for the conversation itself, not just the missing sidebar: the
      // collapsed chrome paints before the chat pane, so asserting visibility
      // alone would pass against a blank page.
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      await captureUiProof(page, "per-tab-02-session-tab-collapsed.png");

      await page.keyboard.press("Meta+B");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await captureUiProof(page, "per-tab-03-session-tab-after-cmd-b.png");
    } finally {
      await context.close();
    }
  });
});
