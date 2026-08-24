import type { Page } from "playwright";
import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "dashboard fullscreen modes",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const initialFocusPath = "focus/dashboard/main/12345678";
const canonicalFocusPath = "/focus/dashboard/main/deploy-monitor-12345678";
const sessionRow = {
  key: sessionKey,
  kind: "direct",
  boardFace: "dashboard",
  displayName: "Deploy monitor",
  updatedAt: 1,
};
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [
    { tabId: "main", title: "Main", position: 0, chatDock: "right" },
    { tabId: "research", title: "Research", position: 1, chatDock: "right" },
  ],
  widgets: [
    {
      name: "status",
      tabId: "main",
      title: "Status",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#status",
    },
    {
      name: "permissions",
      tabId: "main",
      title: "Permissions",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 1,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#permissions",
      declared: { tools: ["openclaw.data.read"], netOrigins: [] },
    },
  ],
};

async function rememberMainTab(page: Page): Promise<void> {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, storageKey }) => {
      const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = {
        ...(settings.boardSessionViews as Record<string, unknown> | undefined),
        [key]: { activeTabId: "main" },
      };
      localStorage.setItem(storageKey, JSON.stringify(settings));
    },
    { key: sessionKey, storageKey: settingsKey },
  );
}

async function openFocusFromDashboards(page: Page, focusPath: string): Promise<void> {
  await page.goto(`${suite.server.baseUrl}dashboards`);
  await page.locator("openclaw-app-shell").waitFor();
  await page.goto(`${suite.server.baseUrl}${focusPath}`);
}

async function closeFocusedView(page: Page, label: "Back" | "Close dashboard"): Promise<void> {
  const action = page.getByRole("button", { name: label, exact: true });
  await action.waitFor();
  await action.click();
  await page.waitForURL(`${suite.server.baseUrl}dashboards`);
}

suite.define(() => {
  it("fails an unsupported focus target visibly without mounting the application shell", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await openFocusFromDashboards(page, "focus/not-supported");
      await page.getByRole("alert").getByText("This focused view is not supported.").waitFor();
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      await closeFocusedView(page, "Back");
    });
  });

  it("renders a live interactive board in the shell-free dashboard document", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        deferredMethods: ["sessions.resolve"],
        featureCapabilities: [GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC],
        featureMethods: ["board.get", "board.update", "board.widget.grant", "board.widget.put"],
        methodResponses: {
          "sessions.describe": {
            session: sessionRow,
          },
          "board.get": boardSnapshot,
          "board.widget.grant": {
            ...boardSnapshot,
            revision: 2,
            widgets: boardSnapshot.widgets.map((widget) =>
              widget.name === "permissions" ? { ...widget, grantState: "rejected" } : widget,
            ),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}${initialFocusPath}`);
      await gateway.waitForRequest("sessions.resolve");
      expect(await gateway.getRequests("board.get")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.resolve", { ok: true, key: sessionKey });
      const document = page.locator("openclaw-board-document");
      await document.locator("openclaw-board-view").waitFor();

      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(await page.locator(".agent-chat").count()).toBe(0);
      expect((await gateway.getRequests("board.get"))[0]?.params).toEqual({ sessionKey });
      await document.getByRole("tab", { name: "Research" }).waitFor();
      const widget = document.locator('[data-widget-name="status"]');
      await widget.waitFor();
      expect(await widget.getAttribute("aria-label")).toContain("Dashboard widget: Status.");
      await document.getByRole("button", { name: "Close dashboard" }).waitFor();
      expect(new URL(page.url()).pathname).toBe(canonicalFocusPath);

      await document
        .locator('[data-widget-name="permissions"]')
        .getByRole("button", { name: "Reject" })
        .click();
      const grant = await gateway.waitForRequest("board.widget.grant");
      expect(grant.params).toEqual({
        sessionKey,
        name: "permissions",
        decision: "rejected",
        revision: 1,
      });

      await gateway.setMethodResponse("board.get", {
        ...boardSnapshot,
        revision: 2,
        widgets: [{ ...boardSnapshot.widgets[0], title: "Updated status", revision: 2 }],
      });
      await gateway.emitGatewayEvent("board.changed", { sessionKey, widget: "status" });
      await expect.poll(() => widget.getAttribute("aria-label")).toContain("Updated status");

      await gateway.setMethodResponse("board.get", {
        sessionKey,
        revision: 3,
        tabs: [],
        widgets: [],
      });
      await gateway.emitGatewayEvent("board.changed", { sessionKey });
      await document.getByText("A clear board, ready for work", { exact: true }).waitFor();
    });
  });

  it("shows the board fullscreen control in split and dashboard faces", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const hiddenDockSnapshot = {
        ...boardSnapshot,
        revision: 2,
        tabs: boardSnapshot.tabs.map((tab) =>
          tab.tabId === "main" ? { ...tab, chatDock: "hidden" } : tab,
        ),
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.get", "board.update"],
        methodResponses: {
          "board.get": boardSnapshot,
          "board.update": hiddenDockSnapshot,
        },
      });
      await rememberMainTab(page);
      await page.goto(`${suite.server.baseUrl}dashboard`);
      await gateway.waitForRequest("board.get");

      const fullscreen = page.locator(".board-fullscreen-button");
      await fullscreen.waitFor();
      expect(await fullscreen.getAttribute("aria-label")).toBe("Enter fullscreen");
      expect(await fullscreen.getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator('wa-radio[value="split"]').getAttribute("class")).toContain(
        "settings-segmented__btn--active",
      );

      await fullscreen.click();
      await expect.poll(() => fullscreen.getAttribute("aria-pressed")).toBe("true");
      expect(
        await page.evaluate(() =>
          document.fullscreenElement?.classList.contains("chat-pane-primary-column"),
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Exit fullscreen" }).click();
      await expect.poll(() => fullscreen.getAttribute("aria-pressed")).toBe("false");

      await page.locator('wa-radio[value="dashboard"]').click();
      await gateway.waitForRequest("board.update");
      await expect
        .poll(() => page.locator('wa-radio[value="dashboard"]').getAttribute("class"))
        .toContain("settings-segmented__btn--active");
      await page.getByRole("button", { name: "Enter fullscreen" }).waitFor();
    });
  });

  it("keeps ambiguity candidates inside the focused dashboard namespace", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const secondKey = "agent:main:dashboard:12345678-aaaa-cdef-1234-567890abcdef";
      const gateway = await installMockGateway(page, {
        featureMethods: ["board.get"],
        methodResponses: {
          "sessions.resolve": {
            ok: false,
            candidates: [{ key: sessionKey }, { key: secondKey }],
          },
          "sessions.describe": {
            sequence: [
              { session: sessionRow },
              {
                session: {
                  ...sessionRow,
                  key: secondKey,
                  displayName: "Deploy monitor beta",
                },
              },
            ],
          },
        },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      const links = page.getByRole("link");
      await expect.poll(() => links.count()).toBe(2);
      for (const link of await links.all()) {
        expect(new URL((await link.getAttribute("href")) ?? "", page.url()).pathname).toMatch(
          /^\/focus\/dashboard\/main\//u,
        );
      }
      expect(await gateway.getRequests("board.get")).toHaveLength(0);
      expect(await page.locator("openclaw-board-document").count()).toBe(0);
      await closeFocusedView(page, "Close dashboard");
    });
  });

  it("shows a clear outcome when the requested session does not exist", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["board.get"],
        methodResponses: { "sessions.resolve": { ok: false } },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      await page.getByText("This session could not be found.", { exact: true }).waitFor();
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(await page.locator("openclaw-board-document").count()).toBe(0);
      expect(await gateway.getRequests("board.get")).toHaveLength(0);
      await closeFocusedView(page, "Close dashboard");
    });
  });

  it("escapes a focused dashboard route-resolution failure", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.resolve": {
            __mockError: { code: "UNAVAILABLE", message: "session routing is unavailable" },
          },
        },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      const alert = page.getByRole("alert");
      await alert.waitFor();
      await expect.poll(() => alert.textContent()).toContain("session routing is unavailable");
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      await closeFocusedView(page, "Close dashboard");
    });
  });

  it("shows an actionable error when the initial board load fails", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.get"],
        methodResponses: {
          "sessions.resolve": { ok: true, key: sessionKey },
          "sessions.describe": {
            session: sessionRow,
          },
          "board.get": {
            __mockError: { code: "UNAVAILABLE", message: "dashboard storage is unavailable" },
          },
        },
      });

      await openFocusFromDashboards(page, initialFocusPath);
      await gateway.waitForRequest("board.get");
      const alert = page.getByRole("alert");
      await alert.waitFor();
      await expect.poll(() => alert.textContent()).toContain("dashboard storage is unavailable");
      await expect.poll(() => alert.textContent()).toContain("try again");
      await closeFocusedView(page, "Close dashboard");
    });
  });
});
