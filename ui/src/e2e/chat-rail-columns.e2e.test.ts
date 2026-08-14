import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { activateChatHeaderPanelAction } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat tabbed side panel",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:rail-tabs";
const proofDir = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();

const historyMessages = Array.from({ length: 10 }, (_, index) => ({
  id: `rail-tabs-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: [
    {
      type: "text",
      text:
        index % 2 === 0
          ? `Review checkpoint ${index + 1}: keep the conversation visible while working with session tools.`
          : `Checkpoint ${index + 1} is ready. The side panel can switch tools without changing the chat context.`,
    },
  ],
  timestamp: Date.now() - (10 - index) * 60_000,
}));

function scenario(): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "browser.request",
      "desktop.observe",
      "environments.list",
      "sessions.diff",
      "tasks.list",
      "terminal.open",
    ],
    historyMessages,
    methodResponses: {
      "artifacts.list": { artifacts: [] },
      "browser.request": {
        cases: [{ match: { method: "GET", path: "/tabs" }, response: { running: true, tabs: [] } }],
      },
      "environments.list": {
        environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
      },
      "sessions.diff": {
        sessionKey,
        root: "/workspace/openclaw",
        branch: "feature/tabbed-side-panel",
        baseRef: "main",
        files: [
          {
            path: "ui/src/pages/chat/chat-pane-render.ts",
            status: "modified",
            additions: 4,
            deletions: 2,
            patch: [
              "diff --git a/ui/src/pages/chat/chat-pane-render.ts b/ui/src/pages/chat/chat-pane-render.ts",
              "--- a/ui/src/pages/chat/chat-pane-render.ts",
              "+++ b/ui/src/pages/chat/chat-pane-render.ts",
              "@@ -1,2 +1,4 @@",
              " existing line",
              "+single side panel",
              "+tab navigation",
              "",
            ].join("\n"),
          },
        ],
        additions: 4,
        deletions: 2,
      },
      "sessions.files.list": {
        browser: {
          path: "ui/src/pages/chat",
          entries: [
            {
              kind: "file",
              name: "chat-pane-render.ts",
              path: "ui/src/pages/chat/chat-pane-render.ts",
            },
            { kind: "file", name: "sidebar.css", path: "ui/src/styles/chat/sidebar.css" },
          ],
        },
        files: [
          {
            kind: "modified",
            missing: false,
            name: "chat-pane-render.ts",
            path: "/workspace/openclaw/ui/src/pages/chat/chat-pane-render.ts",
            size: 18_432,
          },
          {
            kind: "read",
            missing: false,
            name: "sidebar.css",
            path: "/workspace/openclaw/ui/src/styles/chat/sidebar.css",
            size: 24_820,
          },
        ],
        root: "/workspace/openclaw",
        sessionKey,
      },
      "tasks.list": {
        tasks: [
          {
            agentId: "main",
            createdAt: Date.now() - 240_000,
            id: "task-navigation",
            kind: "subagent",
            ownerKey: sessionKey,
            sessionKey,
            progressSummary: "Checking panel navigation and persisted state",
            runtime: "subagent",
            startedAt: Date.now() - 210_000,
            status: "running",
            taskId: "task-navigation",
            title: "Verify tab navigation",
            updatedAt: Date.now(),
          },
        ],
      },
      "terminal.list": { sessions: [] },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/workspace/openclaw",
        sessionId: "rail-tabs-terminal",
        shell: "/bin/zsh",
      },
    },
    sessionKey,
    terminalEnabled: true,
    workspace: "/workspace/openclaw",
    workspaceGit: true,
  };
}

async function seedSettings(page: Page, themeMode: "light" | "dark") {
  const key = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, sessionKey, themeMode }) => {
      if (localStorage.getItem(key) !== null) {
        return;
      }
      localStorage.setItem(
        key,
        JSON.stringify({
          theme: "claw",
          themeMode,
          sidebarSessionLayouts: {
            [sessionKey]: { columns: [], open: false, expanded: false },
          },
        }),
      );
    },
    { key, sessionKey, themeMode },
  );
}

function sidePanel(page: Page): Locator {
  return page.locator(".sidebar-region__right-runtime .side-panel");
}

async function openFromEmpty(page: Page, label: string) {
  const button = sidePanel(page).locator(".side-panel-empty__type").filter({ hasText: label });
  await button.click();
}

async function openFromPlus(page: Page, label: string) {
  const panel = sidePanel(page);
  const dropdown = panel.locator("wa-dropdown.side-panel-type-menu");
  await dropdown.getByRole("button", { name: "Add side panel tab" }).click();
  const item = dropdown.locator("wa-dropdown-item").filter({ hasText: label });
  const afterHide = dropdown.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("wa-after-hide", () => resolve(), { once: true });
      }),
  );
  await item.click();
  await afterHide;
  await expect.poll(() => dropdown.evaluate((element) => Reflect.get(element, "open"))).toBe(false);
}

async function selectTab(page: Page, label: string) {
  await sidePanel(page).locator("wa-tab").filter({ hasText: label }).click();
}

async function tabLabels(page: Page): Promise<string[]> {
  return sidePanel(page)
    .locator(":scope > .side-panel__header > .tabstrip .tabstrip-tab__label")
    .evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ""));
}

async function captureRichPanel(page: Page, name: string) {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  const clip = await page.evaluate(() => {
    const elements = [
      document.querySelector<HTMLElement>(".chat-pane__header"),
      document.querySelector<HTMLElement>(".agent-chat__scroll"),
      document.querySelector<HTMLElement>(".side-panel"),
    ].filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) {
      throw new Error("No chat panel geometry found for evidence clip");
    }
    const rects = elements.map((element) => element.getBoundingClientRect());
    const x = Math.max(0, Math.min(...rects.map((rect) => rect.left)));
    const y = Math.max(0, Math.min(...rects.map((rect) => rect.top)));
    const right = Math.min(innerWidth, Math.max(...rects.map((rect) => rect.right)));
    const bottom = Math.min(innerHeight, Math.max(...rects.map((rect) => rect.bottom)));
    return { x, y, width: right - x, height: bottom - y };
  });
  await page.screenshot({ path: path.join(proofDir, `${name}.png`), clip });
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "navigates and persists one tabbed side panel in %s theme",
    async (themeMode) => {
      await suite.withPage(
        {
          colorScheme: themeMode,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1600 },
        },
        async ({ page }) => {
          await seedSettings(page, themeMode);
          const gateway = await installMockGateway(page, scenario());
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".chat-group").first().waitFor();

          await page.locator(".chat-side-panel-toggle").click();
          await sidePanel(page).locator(".side-panel-empty--selector").waitFor();
          expect(await sidePanel(page).locator("wa-tab").count()).toBe(0);
          await captureRichPanel(page, `rails-tabs-empty-${themeMode}`);

          await openFromEmpty(page, "Files");
          await sidePanel(page).locator('[data-panel-slot="workspace"]:not([hidden])').waitFor();
          await expect.poll(() => sidePanel(page).textContent()).toContain("chat-pane-render.ts");
          await activateChatHeaderPanelAction(page, "Show session changes");
          await gateway.waitForRequest("sessions.diff");
          await sidePanel(page).locator('[data-panel-slot="detail"]:not([hidden])').waitFor();
          await expect.poll(() => sidePanel(page).textContent()).toContain("single side panel");
          await captureRichPanel(page, `rails-tabs-review-${themeMode}`);

          await openFromPlus(page, "Terminal");
          await gateway.waitForRequest("terminal.open");
          await sidePanel(page).locator('[data-panel-slot="terminal"]:not([hidden])').waitFor();
          await openFromPlus(page, "Tasks");
          await expect.poll(() => sidePanel(page).textContent()).toContain("Verify tab navigation");
          await openFromPlus(page, "Browser");
          await sidePanel(page).locator('[data-panel-slot="browser"]:not([hidden])').waitFor();
          await captureRichPanel(page, `rails-tabs-browser-${themeMode}`);
          await openFromPlus(page, "Side chat");
          await sidePanel(page).locator('[data-panel-slot="companion"]:not([hidden])').waitFor();
          await openFromPlus(page, "Desktop");
          await sidePanel(page).locator('[data-panel-slot="desktop"]:not([hidden])').waitFor();
          await sidePanel(page).getByText("Desktop sources", { exact: true }).waitFor();
          await captureRichPanel(page, `rails-tabs-desktop-${themeMode}`);
          expect(await tabLabels(page)).toEqual([
            "Files",
            "Review",
            "Terminal",
            "Tasks",
            "Browser",
            "Side chat",
            "Desktop",
          ]);

          await selectTab(page, "Files");
          await captureRichPanel(page, `rails-tabs-rich-${themeMode}`);

          const panelWidth = await sidePanel(page).evaluate(
            (element) => element.getBoundingClientRect().width,
          );
          const divider = page.locator(".sidebar-column__divider");
          const dividerBox = await divider.boundingBox();
          expect(dividerBox).not.toBeNull();
          await page.mouse.move(dividerBox!.x + 1, dividerBox!.y + dividerBox!.height / 2);
          await page.mouse.down();
          await page.mouse.move(dividerBox!.x - 90, dividerBox!.y + dividerBox!.height / 2);
          await page.mouse.up();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeGreaterThan(panelWidth + 70);
          const resizedWidth = await sidePanel(page).evaluate(
            (element) => element.getBoundingClientRect().width,
          );

          await sidePanel(page).getByRole("button", { name: "Expand side panel" }).click();
          await expect
            .poll(() =>
              page
                .locator(".sidebar-region__primary")
                .evaluate((element) => getComputedStyle(element).display),
            )
            .toBe("none");
          await sidePanel(page).getByRole("button", { name: "Restore side panel" }).click();

          await sidePanel(page).getByRole("button", { name: "Minimize side panel" }).click();
          await expect.poll(() => sidePanel(page).count()).toBe(0);
          await page.locator(".chat-side-panel-toggle").click();
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeCloseTo(resizedWidth, 0);

          await page.reload();
          await page.locator(".chat-group").first().waitFor();
          await sidePanel(page).waitFor();
          expect(await tabLabels(page)).toEqual([
            "Files",
            "Review",
            "Terminal",
            "Tasks",
            "Browser",
            "Side chat",
            "Desktop",
          ]);
          await expect
            .poll(() =>
              sidePanel(page).evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeCloseTo(resizedWidth, 0);
          expect(
            await sidePanel(page)
              .locator(
                ":scope > .side-panel__header > .tabstrip wa-tab[active] .tabstrip-tab__label",
              )
              .textContent(),
          ).toContain("Files");

          await page.keyboard.press("Meta+Shift+B");
          await expect.poll(async () => (await tabLabels(page)).includes("Files")).toBe(false);
          await page.keyboard.press("Meta+Shift+B");
          await expect.poll(async () => (await tabLabels(page)).at(-1)).toBe("Files");
          await page.keyboard.press("Control+Backquote");
          await expect.poll(async () => (await tabLabels(page)).includes("Terminal")).toBe(false);
          await page.keyboard.press("Control+Backquote");
          await expect.poll(async () => (await tabLabels(page)).at(-1)).toBe("Terminal");

          for (const label of [
            "Review",
            "Tasks",
            "Browser",
            "Side chat",
            "Desktop",
            "Files",
            "Terminal",
          ]) {
            await sidePanel(page)
              .locator(":scope > .side-panel__header")
              .getByRole("button", { name: `Close ${label}`, exact: true })
              .click();
          }
          await sidePanel(page).locator(".side-panel-empty--selector").waitFor();
          await sidePanel(page).getByRole("button", { name: "Minimize side panel" }).click();
          await page.locator(".chat-side-panel-toggle").click();
          await sidePanel(page).locator(".side-panel-empty--selector").waitFor();
          expect(await sidePanel(page).locator("wa-tab").count()).toBe(0);
        },
      );
    },
  );

  it("keeps navigation usable on a mobile viewport", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        await seedSettings(page, "light");
        await installMockGateway(page, scenario());
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-group").first().waitFor();
        await page.locator(".chat-side-panel-toggle").click();
        await openFromEmpty(page, "Files");
        await openFromPlus(page, "Terminal");
        await expect.poll(async () => tabLabels(page)).toEqual(["Files", "Terminal"]);

        const geometry = await sidePanel(page).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.width).toBeGreaterThan(300);

        await sidePanel(page).getByRole("button", { name: "Expand side panel" }).click();
        await expect
          .poll(() =>
            page
              .locator(".sidebar-region__primary")
              .evaluate((element) => getComputedStyle(element).display),
          )
          .toBe("none");
        await captureRichPanel(page, "rails-tabs-mobile-light");
      },
    );
  });
});
