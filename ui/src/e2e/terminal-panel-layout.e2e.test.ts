import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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
