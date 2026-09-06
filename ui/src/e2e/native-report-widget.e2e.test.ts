import path from "node:path";
import { expect, it } from "vitest";
import type { BoardReport } from "../../../src/boards/board-report.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native report dashboard widget",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:community-report";

function reportSnapshot(detailsUrl: string, revision = 1) {
  const props: BoardReport = {
    blocks: [
      {
        type: "text",
        title: "Community pulse",
        text:
          revision === 1
            ? "A welcoming week: more questions answered, fewer unresolved threads."
            : "Updated after the afternoon review: every question has an owner.",
      },
      {
        type: "metrics",
        items: [
          {
            label: "Questions answered",
            value: revision === 1 ? "42" : "48",
            detail: "+12 this week",
          },
          { label: "Helpful replies", value: "96%", detail: "Across 120 conversations" },
          { label: "Open threads", value: "7", detail: "All assigned" },
        ],
      },
      {
        type: "table",
        title: "Topics this week",
        columns: ["Topic", "Conversations", "Mood"],
        rows: [
          ["Getting started", "54", "Curious"],
          ["Projects", "38", "Positive"],
          ["Feedback", "28", "Constructive"],
        ],
      },
      {
        type: "chart",
        title: "Daily helpful replies",
        style: "bar",
        points: [
          { label: "Mon", value: 18 },
          { label: "Tue", value: 24 },
          { label: "Wed", value: 21 },
          { label: "Thu", value: 32 },
        ],
      },
      {
        type: "links",
        title: "Explore the report",
        items: [
          { label: "Details", url: detailsUrl, detail: "Read the synthetic weekly summary." },
        ],
      },
    ],
  };
  return {
    sessionKey,
    revision,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "community-report",
        tabId: "main",
        title: "Weekly community report",
        contentKind: "plugin",
        pluginKind: "session:report",
        props,
        sizeW: 12,
        sizeH: 20,
        position: 0,
        grantState: "none",
        revision,
      },
    ],
  };
}

suite.define(() => {
  it.each([
    { height: 900, name: "desktop", width: 1440 },
    { height: 844, name: "mobile", width: 390 },
  ])("renders and refreshes a native report without a document on $name", async (viewport) => {
    await suite.withPage(
      { viewport, recordVideo: { dir: suite.artifactDir, size: viewport } },
      async ({ context, page }) => {
        const detailsUrl = new URL("/native-report-details", suite.server.baseUrl).href;
        const documents: string[] = [];
        context.on("request", (request) => {
          if (request.resourceType() === "document") {
            documents.push(request.url());
          }
        });
        await context.route(detailsUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Report details</title><h1>Weekly report details</h1><p>Synthetic community summary.</p>",
          }),
        );
        const gateway = await installMockGateway(page, {
          sessionKey,
          controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
          featureMethods: [
            "board.get",
            "chat.metadata",
            "chat.startup",
            "sessions.list",
            "sessions.patch",
          ],
          methodResponses: {
            "board.get": reportSnapshot(detailsUrl),
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Community report", updatedAt: Date.now() },
            ]),
          },
        });
        await page.addInitScript(
          ({ key, storage }) => {
            localStorage.setItem(
              storage,
              JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
            );
          },
          { key: sessionKey, storage: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );

        const dashboardUrl = controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard");
        await page.goto(dashboardUrl);
        const report = page.locator("openclaw-report-widget");
        await report.waitFor();
        await expect.poll(() => report.textContent()).toContain("A welcoming week");
        expect(await report.getByRole("article", { name: "Weekly community report" }).count()).toBe(
          1,
        );
        expect(await report.locator(".board-report__metrics").textContent()).toContain("42");
        expect(await report.getByRole("columnheader").allTextContents()).toEqual([
          "Topic",
          "Conversations",
          "Mood",
        ]);
        expect(await report.getByRole("cell", { name: "Constructive", exact: true }).count()).toBe(
          1,
        );
        expect(await report.locator(".board-report__chart rect").count()).toBe(4);
        expect(await report.locator(".board-report__values").textContent()).toContain("Thu");
        const details = report.getByRole("link", { name: "Details", exact: true });
        expect(await details.getAttribute("href")).toBe(detailsUrl);
        expect(await page.locator("iframe").count()).toBe(0);
        expect(page.frames()).toHaveLength(1);
        expect(documents).toEqual([dashboardUrl]);
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, `report-${viewport.name}.png`),
        });

        const originalReport = await report.evaluateHandle((element) => element);
        const reads = (await gateway.getRequests("board.get")).length;
        await gateway.setMethodResponse("board.get", reportSnapshot(detailsUrl, 2));
        await gateway.emitGatewayEvent("board.changed", {
          sessionKey,
          revision: 2,
          widget: "community-report",
        });
        await gateway.waitForRequest("board.get", { after: reads });
        await expect
          .poll(() => report.textContent())
          .toContain("Updated after the afternoon review");
        expect(await report.locator(".board-report__metrics").textContent()).toContain("48");
        expect(
          await originalReport.evaluate(
            (element) =>
              element.isConnected && element === document.querySelector("openclaw-report-widget"),
          ),
        ).toBe(true);
        await originalReport.dispose();
        expect(documents).toEqual([dashboardUrl]);
        expect(await page.locator("iframe").count()).toBe(0);
        expect(page.frames()).toHaveLength(1);
        await report.locator(".board-report__chart").scrollIntoViewIfNeeded();
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, `report-updated-${viewport.name}.png`),
        });

        const opened = context.waitForEvent("page");
        await details.click();
        const detailsPage = await opened;
        await detailsPage.getByRole("heading", { name: "Weekly report details" }).waitFor();
        expect(detailsPage.url()).toBe(detailsUrl);
        expect(await detailsPage.evaluate(() => window.opener === null)).toBe(true);
        expect(documents).toEqual([dashboardUrl, detailsUrl]);
        expect(page.url()).toBe(dashboardUrl);
      },
    );
  });
});
