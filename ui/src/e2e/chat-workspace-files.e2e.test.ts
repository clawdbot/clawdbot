import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("starts the workspace files panel collapsed and toggles it open", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "artifacts.list": {
          artifacts: [
            {
              download: { mode: "bytes" },
              id: "artifact-1",
              mimeType: "image/png",
              sizeBytes: 128,
              title: "preview.png",
              type: "image",
            },
          ],
        },
        "sessions.files.list": {
          browser: {
            entries: [
              {
                kind: "directory",
                name: "src",
                path: "src",
                sessionKind: "modified",
              },
              {
                kind: "file",
                name: "package.json",
                path: "package.json",
                size: 4096,
              },
            ],
            path: "",
          },
          files: [
            {
              kind: "modified",
              missing: false,
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              size: 2048,
            },
          ],
          root: "/workspace",
          sessionKey: "main",
        },
        "sessions.diff": {
          additions: 1,
          branch: "main",
          deletions: 0,
          files: [
            {
              additions: 1,
              deletions: 0,
              path: "AFTER_RUN.md",
              status: "modified",
            },
          ],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);

      await openChatSidePanelType(page, "Files");
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });
      await page
        .locator(".chat-workspace-rail__file-name", { hasText: "preview.png" })
        .waitFor({ timeout: 10_000 });
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await page.locator(".chat-workspace-rail__file-name", { hasText: "package.json" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);
      expect(
        await page.locator(".chat-workspace-rail").evaluate((element) => {
          return window.innerWidth - element.getBoundingClientRect().right;
        }),
      ).toBe(0);

      await page.getByRole("button", { name: "Close Files" }).click();
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);
      await gateway.setMethodResponse("sessions.files.list", {
        files: [
          {
            kind: "modified",
            name: "AFTER_RUN.md",
            path: "/workspace/AFTER_RUN.md",
          },
        ],
      });
      await gateway.emitChatFinal({
        runId: "workspace-closed-run",
        text: "Workspace stayed closed.",
      });
      await expect.poll(() => page.getByText("Workspace stayed closed.").count()).toBe(1);
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      await openChatSidePanelType(page, "Files");
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(2);
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AFTER_RUN.md" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(2);

      await openChatSidePanelType(page, "Review");
      await page.locator('[data-panel-slot="detail"]:not([hidden])').waitFor();
      await page.getByRole("button", { name: "Actions for AFTER_RUN.md" }).click();
      await page
        .locator('openclaw-session-diff-menu wa-dropdown-item[value="reveal-file"]')
        .click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(3);
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AFTER_RUN.md" }).waitFor({
        timeout: 10_000,
      });
      await page.locator("wa-tab").filter({ hasText: "Review" }).click();
      await gateway.setMethodResponse("sessions.files.list", {
        files: [
          {
            kind: "modified",
            name: "AFTER_REVIEW.md",
            path: "/workspace/AFTER_REVIEW.md",
          },
        ],
      });
      await gateway.emitChatFinal({
        runId: "workspace-inactive-run",
        text: "Workspace stayed inactive.",
      });
      await page.getByText("Workspace stayed inactive.").first().waitFor();
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(3);

      await page.locator("wa-tab").filter({ hasText: "Files" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(4);
      await page
        .locator(".chat-workspace-rail__file-name", { hasText: "AFTER_REVIEW.md" })
        .waitFor({ timeout: 10_000 });

      await page.setViewportSize({ height: 900, width: 640 });
      await page.locator(".side-panel--narrow").waitFor();
      const workspaceRail = page.locator(".chat-workspace-rail");
      await expect
        .poll(async () => {
          const box = await workspaceRail.boundingBox();
          return Boolean(box && box.width > 0 && box.height > 0);
        })
        .toBe(true);
      expect(await page.locator(".chat-workspace-rail__dock").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__grip").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps long workspace file sections scrollable inside the rail", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const browserEntries = Array.from({ length: 60 }, (_, index) => ({
      kind: "file" as const,
      name: `file-${String(index + 1).padStart(2, "0")}.ts`,
      path: `src/file-${String(index + 1).padStart(2, "0")}.ts`,
      size: 2048 + index,
    }));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.list": {
          browser: { entries: browserEntries, path: "" },
          files: [],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      await page.locator(".chat-workspace-rail__file-name", { hasText: "file-60.ts" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      const browserSection = page.locator(".chat-workspace-rail__section", {
        hasText: "Project files",
      });
      await expect
        .poll(
          () =>
            browserSection.evaluate((section) => {
              const element = section as HTMLElement;
              const scroll = element.closest(".chat-workspace-rail__scroll") as HTMLElement | null;
              if (!scroll) {
                throw new Error("Expected workspace rail scroll container");
              }
              const sectionRect = element.getBoundingClientRect();
              const scrollRect = scroll.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                bottomWithinRail: Math.ceil(sectionRect.bottom) <= Math.ceil(scrollRect.bottom),
                clientHeight: element.clientHeight,
                overflowY: style.overflowY,
                scrollHeight: element.scrollHeight,
              };
            }),
          { timeout: 10_000 },
        )
        .toMatchObject({ bottomWithinRail: true, overflowY: "auto" });
      const sectionMetrics = await browserSection.evaluate((section) => {
        const element = section as HTMLElement;
        return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
      });
      expect(sectionMetrics.scrollHeight).toBeGreaterThan(sectionMetrics.clientHeight);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
