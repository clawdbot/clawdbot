import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI terminal open",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

async function openTerminalSidePanel(page: Page): Promise<Locator> {
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiGatewayReady(page);
  await openChatSidePanelType(page, "Terminal");
  return page.locator(".sidebar-region__right-runtime openclaw-terminal-panel");
}

async function canvasDigest(canvas: Locator): Promise<string> {
  const png = await canvas.screenshot({ animations: "disabled", caret: "hide" });
  return createHash("sha256").update(png).digest("hex");
}

async function settleTerminalPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function cycleThemeMode(page: Page, currentMode: "Dark" | "Light" | "System") {
  const sidebar = page.locator("openclaw-app-sidebar");
  const toggle = sidebar.getByRole("button", { name: `Color mode: ${currentMode}` });
  if (!(await toggle.isVisible())) {
    await sidebar.getByRole("button", { name: /^Identity and app menu for / }).click();
  }
  await toggle.click();
}

suite.define(() => {
  it("opens against the shared mock and renders echoed terminal output", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.startup", "terminal.open"],
        terminalEnabled: true,
      });

      const panel = await openTerminalSidePanel(page);
      await gateway.waitForRequest("terminal.open");
      await panel.locator(".tabstrip-tab.is-live").waitFor();
      const canvas = panel.locator(".tp-host canvas");
      await canvas.waitFor({ state: "visible" });
      await settleTerminalPaint(page);
      const bannerDigest = await canvasDigest(canvas);

      const sentinel = "PROVABLE_MOCK_TERMINAL";
      await canvas.click();
      await page.keyboard.type(sentinel);
      await expect
        .poll(async () =>
          (await gateway.getRequests("terminal.input"))
            .map((request) => (request.params as { data?: string }).data ?? "")
            .join(""),
        )
        .toContain(sentinel);
      await expect.poll(() => canvasDigest(canvas)).not.toBe(bannerDigest);
    });
  });

  it("keeps an open side-panel terminal synchronized with light and dark mode", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.startup", "terminal.open"],
          terminalEnabled: true,
        });

        const panel = await openTerminalSidePanel(page);
        await gateway.waitForRequest("terminal.open");
        const canvas = panel.locator(".tp-host canvas");
        await canvas.waitFor({ state: "visible" });
        await canvas.evaluate((element) => {
          element.dataset.themeSyncIdentity = "original";
        });
        await cycleThemeMode(page, "System");
        await cycleThemeMode(page, "Light");
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
        await expect
          .poll(() => panel.evaluate((element) => Reflect.get(element, "themeMode")))
          .toBe("dark");

        await cycleThemeMode(page, "Dark");
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
        await expect
          .poll(() => panel.evaluate((element) => Reflect.get(element, "themeMode")))
          .toBe("light");
        expect(await canvas.getAttribute("data-theme-sync-identity")).toBe("original");

        await page.locator(".chat-side-panel-toggle").click();
        await expect.poll(() => canvas.isVisible()).toBe(false);
        await page.locator(".chat-side-panel-toggle").click();
        await canvas.waitFor({ state: "visible" });
        await expect
          .poll(() => panel.evaluate((element) => Reflect.get(element, "themeMode")))
          .toBe("light");
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
      },
    );
  });

  it("names a missing field and retries the open successfully", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.startup", "terminal.open"],
        methodResponses: {
          "terminal.open": {
            sequence: [
              {
                agentId: "main",
                confined: false,
                sessionId: "terminal-missing-cwd",
                shell: "/bin/zsh",
              },
              {
                agentId: "main",
                confined: false,
                cwd: "/workspace/openclaw",
                sessionId: "terminal-retry-ready",
                shell: "/bin/zsh",
              },
            ],
          },
        },
        terminalEnabled: true,
      });

      const panel = await openTerminalSidePanel(page);
      const error =
        "The Gateway returned an unusable terminal session (missing cwd). The Gateway is likely older than this Control UI — update it, then retry.";
      await panel.getByText(error, { exact: true }).waitFor();
      const retry = panel.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);

      await retry.click();
      await expect.poll(async () => (await gateway.getRequests("terminal.open")).length).toBe(2);
      await panel.locator(".tabstrip-tab.is-live").waitFor();
      const canvas = panel.locator(".tp-host canvas");
      await canvas.waitFor({ state: "visible" });
      await settleTerminalPaint(page);
      const blankDigest = await canvasDigest(canvas);
      const retryOutput = "Retry opened terminal\r\n";
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "terminal-retry-ready",
        seq: retryOutput.length,
        data: retryOutput,
      });

      await expect.poll(() => canvasDigest(canvas)).not.toBe(blankDigest);
      expect(await panel.getByText(error, { exact: true }).count()).toBe(0);
    });
  });
});
