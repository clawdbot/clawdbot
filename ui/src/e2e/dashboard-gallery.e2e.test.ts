import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard gallery",
  startServerBeforeBrowser: true,
});

const now = Date.now();
const selectedSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const dashboardRows = [
  [selectedSessionKey, "Release health", "mira", "Mira", 3_000, "running"],
  ["agent:main:dashboard:model-spend", "Model spend", "peter", "Peter", 8_000, "done"],
  ["agent:main:dashboard:support-radar", "Support radar", "mira", "Mira", 18_000, "done"],
  ["agent:main:dashboard:ci-signal", "CI signal", "peter", "Peter", 42_000, "done"],
  ["agent:main:dashboard:community-pulse", "Community pulse", "mira", "Mira", 75_000, "done"],
  ["agent:main:dashboard:gateway-fleet", "Gateway fleet", "peter", "Peter", 130_000, "done"],
].map(([key, displayName, actorId, actorLabel, age, status]) => ({
  key: String(key),
  kind: "direct",
  boardFace: "dashboard",
  displayName: String(displayName),
  updatedAt: now - Number(age),
  status: String(status),
  createdActor: { type: "human", id: String(actorId), label: String(actorLabel) },
}));

const boardSnapshot = {
  sessionKey: selectedSessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [],
};

suite.define(() => {
  it("opens a responsive gallery card in its owning chat with the dashboard expanded", async () => {
    const proofDir = process.env.OPENCLAW_UI_E2E_RECORD === "1" ? suite.artifactDir : null;
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        sessionKey: selectedSessionKey,
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "sessions.resolve"],
        methodResponses: {
          "board.get": boardSnapshot,
          "sessions.resolve": {
            ok: true,
            key: selectedSessionKey,
            boardFace: "dashboard",
          },
          "sessions.list": {
            cases: [
              {
                match: { hasBoard: true },
                response: {
                  count: dashboardRows.length,
                  defaults: { contextTokens: null, model: null, modelProvider: null },
                  path: "",
                  sessions: dashboardRows,
                  ts: now,
                },
              },
            ],
          },
        },
      });

      await page.goto(suite.server.baseUrl);
      await page.getByRole("link", { name: "Dashboards", exact: true }).click();
      await page.waitForURL(`${suite.server.baseUrl}dashboards`);
      const gallery = page.locator("openclaw-dashboards-page");
      const releaseCard = gallery.locator("[data-dashboard-session]", {
        hasText: "Release health",
      });
      await releaseCard.waitFor();
      expect(await gallery.locator("[data-dashboard-session]").count()).toBe(6);
      expect(await gallery.getByText("By Mira", { exact: true }).count()).toBe(3);
      expect(await releaseCard.locator("a").getAttribute("href")).toBe(
        "/chat/main/release-health-12345678?dashboard=expanded",
      );
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "01-gallery.png") });
      }

      await releaseCard.locator("a").click();
      await page.waitForURL(/\/chat\/main\/release-health-12345678\?dashboard=expanded$/u);
      await page.locator(".board-session-surface").waitFor();
      await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
      await expect.poll(() => page.locator(".chat-thread").isHidden()).toBe(true);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "02-expanded-dashboard.png") });
      }

      await page.getByRole("button", { name: "Collapse", exact: true }).click();
      await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
      await page.locator(".chat-thread").waitFor();
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "03-split-dashboard.png") });
      }
      await page.locator(".side-panel__minimize").click();
      await expect.poll(() => page.locator(".board-session-surface").count()).toBe(0);
      await page.locator(".chat-thread").waitFor();
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "04-chat-only.png") });
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await gallery.getByText("Release health", { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.evaluate(() => ({
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
          })),
        )
        .toEqual({ documentWidth: 390, viewportWidth: 390 });
      expect(
        await gallery
          .locator(".dashboards-grid")
          .evaluate(
            (element) =>
              getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
          ),
      ).toBe(1);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "05-gallery-mobile.png") });
      }
    } finally {
      await context.close();
    }
  });
});
