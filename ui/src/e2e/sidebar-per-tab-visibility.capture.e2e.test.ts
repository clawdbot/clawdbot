import { expect, it } from "vitest";
import { SIDEBAR_SESSION_NAV_COLLAPSE_QUERY } from "../app-session-route-paths.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
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

function catalogSessionsMock() {
  const scenario = sessionsMock();
  return {
    ...scenario,
    featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
    methodResponses: {
      ...scenario.methodResponses,
      "sessions.catalog.list": {
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: { continueSession: true, archive: true },
            hosts: [
              {
                hostId: "gateway:local",
                label: "Local Codex",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: "thread-sidebar-collapse",
                    name: "Catalog session notes",
                    status: "idle",
                    archived: false,
                    canContinue: true,
                    canArchive: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      "sessions.catalog.read": {
        hostId: "gateway:local",
        threadId: "thread-sidebar-collapse",
        items: [{ id: "catalog-message", type: "userMessage", text: "Catalog transcript loaded" }],
      },
    },
  };
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

  it("keeps the sidebar on an unmarked direct conversation link", async () => {
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
      const composer = page.getByPlaceholder("Message OpenClaw");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebar.isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("collapses the sidebar only for a session opened in a new tab, and Cmd+B restores it", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, sessionsMock());
      const sessionUrl = new URL(controlUiSessionUrl(suite.server.baseUrl, RESEARCH_KEY));
      sessionUrl.searchParams.set(
        SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name,
        SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.value,
      );
      await page.goto(sessionUrl.href);
      const sidebar = page.locator("openclaw-app-sidebar");
      const expandButton = page.locator(".shell-chrome-controls__nav-toggle");
      const composer = page.getByPlaceholder("Message OpenClaw");
      await expandButton.waitFor({ state: "visible", timeout: 10_000 });
      // Wait for the conversation itself, not just the missing sidebar: the
      // collapsed chrome paints before the chat pane, so asserting visibility
      // alone would pass against a blank page.
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      expect(new URL(page.url()).searchParams.has(SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name)).toBe(
        false,
      );
      await captureUiProof(page, "per-tab-02-session-tab-collapsed.png");

      await page.keyboard.press("Meta+B");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await captureUiProof(page, "per-tab-03-session-tab-after-cmd-b.png");

      await page.reload();
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  it("collapses a native catalog-session tab while rendering its conversation", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, catalogSessionsMock());
      await page.goto(`${suite.server.baseUrl}chat`);
      const catalogLink = page.locator(
        '[data-session-section="catalog:codex"] .sidebar-recent-session__link',
      );
      await catalogLink.waitFor({ state: "visible", timeout: 10_000 });
      const catalogHref = await catalogLink.getAttribute("href");
      expect(catalogHref).not.toBeNull();
      const catalogUrl = new URL(catalogHref!, page.url());
      expect(catalogUrl.searchParams.get(SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name)).toBe(
        SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.value,
      );

      const catalogTab = await context.newPage();
      const gateway = await installMockGateway(catalogTab, catalogSessionsMock());
      await catalogTab.goto(catalogUrl.href);
      const composer = catalogTab.locator(".agent-chat__composer-combobox > textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await catalogTab.getByText("Catalog transcript loaded", { exact: true }).waitFor();
      await expect.poll(() => catalogTab.locator("openclaw-app-sidebar").isVisible()).toBe(false);
      expect(
        new URL(catalogTab.url()).searchParams.has(SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name),
      ).toBe(false);
      expect((await gateway.waitForRequest("sessions.catalog.read")).params).toMatchObject({
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "thread-sidebar-collapse",
      });
      await captureUiProof(catalogTab, "per-tab-04-catalog-session-tab-collapsed.png");
    } finally {
      await context.close();
    }
  });
});
