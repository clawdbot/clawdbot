import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  activateChatHeaderPanelAction,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI terminal panel layout",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const screenshotDir = process.env.OPENCLAW_TERMINAL_LAYOUT_SCREENSHOT_DIR?.trim();

async function captureLayout(page: Page, theme: string, state: string): Promise<void> {
  if (!screenshotDir) {
    return;
  }
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(screenshotDir, `${theme}-${state}-context.png`),
  });
  await page.locator("openclaw-terminal-panel .tp-header").screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(screenshotDir, `${theme}-${state}-crop.png`),
  });
}

suite.define(() => {
  it.each(
    [
      { label: "Files", slot: "workspace", shortcut: "Shift+Meta+B" },
      { label: "Terminal", slot: "terminal", shortcut: "Control+Backquote" },
    ].flatMap((target) => [
      { ...target, action: "shortcut" },
      { ...target, action: "header" },
    ]),
  )("reveals retained $label via $action before toggling it closed", async (target) => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["terminal.open"],
          terminalEnabled: true,
          methodResponses: { "tasks.list": { tasks: [] } },
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Panel shortcut workspace." }] },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        await page.getByPlaceholder("Message OpenClaw").waitFor();
        const panel = page.locator(`.side-panel__panel[data-panel-slot="${target.slot}"]`);
        const tab = page.locator(".side-panel__header-tabs").getByRole("tab", {
          name: target.label,
          exact: true,
        });
        const tasks = page.locator('.side-panel__panel[data-panel-slot="tasks"]');
        const toggle = (visible = false) =>
          target.action === "shortcut"
            ? page.keyboard.press(target.shortcut)
            : activateChatHeaderPanelAction(
                page,
                target.slot === "terminal"
                  ? "Toggle terminal"
                  : visible
                    ? "Collapse session workspace"
                    : "Show session files",
              );
        const capture = async (state: string) => {
          if (screenshotDir) {
            await fs.mkdir(screenshotDir, { recursive: true });
            await page.screenshot({
              animations: "disabled",
              caret: "hide",
              path: path.join(screenshotDir, `${target.action}-${target.slot}-${state}.png`),
            });
          }
        };

        await openChatSidePanelType(page, target.label);
        await panel.waitFor({ state: "visible" });
        await gateway.waitForRequest(
          target.slot === "terminal" ? "terminal.open" : "sessions.files.list",
        );
        await openChatSidePanelType(page, "Tasks");
        await tasks.waitFor({ state: "visible" });
        expect(await panel.count()).toBe(1);
        expect(await panel.isVisible()).toBe(false);
        expect(await tab.getAttribute("aria-selected")).toBe("false");
        await capture("retained");

        await toggle();
        try {
          await expect.poll(() => panel.isVisible()).toBe(true);
        } finally {
          await capture("shortcut-result");
        }
        expect(await tab.getAttribute("aria-selected")).toBe("true");
        const tasksToggle = page.locator(".chat-tasks-toggle");
        expect(await tasksToggle.getAttribute("aria-expanded")).toBe("false");
        expect(await tasksToggle.getAttribute("aria-label")).toBe("Show background tasks");

        await toggle(true);
        await expect.poll(() => tab.count()).toBe(0);
        expect(await tasks.isVisible()).toBe(true);
        await toggle();
        await panel.waitFor({ state: "visible" });
        await page.locator(".side-panel__minimize").click();
        await panel.waitFor({ state: "hidden" });
        await toggle();
        await panel.waitFor({ state: "visible" });
        expect(await tasks.count()).toBe(1);
        await capture("restored");
      },
    );
  });

  it.each(["light", "dark"] as const)(
    "toggles main content back to bottom and right in %s mode",
    async (theme) => {
      await suite.withPage(
        {
          colorScheme: theme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 800, width: 1280 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [
              {
                content: [{ type: "text", text: "Review the release checklist and recent CI." }],
                role: "user",
                timestamp: Date.now() - 3_000,
              },
              {
                content: [
                  {
                    type: "text",
                    text: [
                      "## Release workspace",
                      "",
                      "- CI checks are green",
                      "- Two review notes remain",
                      "- Terminal is ready for the focused command",
                    ].join("\n"),
                  },
                ],
                role: "assistant",
                timestamp: Date.now() - 2_000,
              },
              {
                content: [
                  { type: "text", text: "Keep the transcript visible while we verify it." },
                ],
                role: "user",
                timestamp: Date.now() - 1_000,
              },
            ],
            featureMethods: ["terminal.open"],
            methodResponses: {
              "terminal.list": { sessions: [] },
              "terminal.open": {
                agentId: "main",
                confined: false,
                cwd: "/workspace/openclaw",
                sessionId: `terminal-layout-${theme}`,
                shell: "/bin/zsh",
              },
            },
            terminalEnabled: true,
          });

          await page.goto(`${suite.server.baseUrl}activity`);
          await waitForControlUiGatewayReady(page);
          await waitForControlUiTerminalReady(page);
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
          await page.keyboard.press("Control+Backquote");
          await gateway.waitForRequest("terminal.open");
          await gateway.emitGatewayEvent("terminal.data", {
            sessionId: `terminal-layout-${theme}`,
            seq: 0,
            data: "OpenClaw release workspace\r\n$ pnpm test ui/src/components/terminal/terminal-panel.test.ts\r\n22 tests passed\r\n$ ",
          });

          const panel = page.locator("openclaw-terminal-panel");
          const surface = panel.locator(".tp");
          const fill = panel.getByRole("button", { name: "Fill main content area" });
          const bottom = panel.getByRole("button", { name: "Dock to bottom" });
          const right = panel.getByRole("button", { name: "Dock to right" });

          await expect.poll(() => surface.getAttribute("class")).toContain("tp--bottom");
          await captureLayout(page, theme, "bottom");
          await fill.click();
          await expect.poll(() => surface.getAttribute("class")).toContain("tp--main");
          await expect.poll(() => fill.count()).toBe(0);
          await captureLayout(page, theme, "bottom-fill");
          await bottom.click();
          const bottomRestored = await surface.getAttribute("class");
          await captureLayout(page, theme, "bottom-restored");

          await right.click();
          await expect.poll(() => surface.getAttribute("class")).toContain("tp--right");
          await captureLayout(page, theme, "right");
          await fill.click();
          await expect.poll(() => surface.getAttribute("class")).toContain("tp--main");
          await expect.poll(() => fill.count()).toBe(0);
          await captureLayout(page, theme, "right-fill");
          await right.click();
          const rightRestored = await surface.getAttribute("class");
          await captureLayout(page, theme, "right-restored");

          expect(bottomRestored).toContain("tp--bottom");
          expect(rightRestored).toContain("tp--right");
        },
      );
    },
  );
});
