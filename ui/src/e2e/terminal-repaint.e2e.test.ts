import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI terminal repaint",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const screenshotPath = process.env.OPENCLAW_TERMINAL_REPAINT_SCREENSHOT?.trim();

async function terminalCanvasDigest(canvas: Locator): Promise<string> {
  const png = await canvas.screenshot({ animations: "disabled", caret: "hide" });
  return createHash("sha256").update(png).digest("hex");
}

suite.define(() => {
  it("keeps one interactive terminal sized and clean across repeated hide and show cycles", async () => {
    await suite.withPage(
      {
        serviceWorkers: "block",
        viewport: { width: 1180, height: 520 },
      },
      async ({ page }) => {
        await page.addInitScript(() => {
          (
            window as Window & {
              ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
            }
          )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
            gatewayUrl: "ws://gateway.example.test",
            token: "test",
          };
        });
        const gateway = await installMockGateway(page, {
          featureMethods: ["terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": {
              agentId: "main",
              confined: false,
              cwd: "/workspace",
              sessionId: "terminal-repaint-e2e",
              shell: "/bin/zsh",
            },
          },
          terminalEnabled: true,
        });

        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiGatewayReady(page);
        await waitForControlUiTerminalReady(page);
        await page.keyboard.press("Control+Backquote");
        const openRequest = await gateway.waitForRequest("terminal.open");
        const openParams = openRequest.params as { cols?: unknown };

        const hideTerminal = page.getByRole("button", { name: "Hide terminal" });
        const terminalCanvas = page.locator(".tp-host canvas");
        await terminalCanvas.waitFor({ state: "visible" });
        const blankCanvasDigest = await terminalCanvasDigest(terminalCanvas);
        await gateway.emitGatewayEvent("terminal.data", {
          sessionId: "terminal-repaint-e2e",
          seq: 0,
          data: "\u001b[?25lterminal repaint sentinel\r\n$ ",
        });
        await expect.poll(() => terminalCanvasDigest(terminalCanvas)).not.toBe(blankCanvasDigest);
        const renderedCanvasDigest = await terminalCanvasDigest(terminalCanvas);

        if (screenshotPath) {
          await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
          await page.screenshot({ path: screenshotPath });
        }

        expect(openParams.cols).toBeTypeOf("number");
        expect(openParams.cols).toBeGreaterThanOrEqual(125);

        for (let cycle = 0; cycle < 3; cycle += 1) {
          await hideTerminal.click();
          await expect.poll(() => terminalCanvas.count()).toBe(0);
          await page.keyboard.press("Control+Backquote");
          await terminalCanvas.waitFor({ state: "visible" });
          await expect.poll(() => terminalCanvasDigest(terminalCanvas)).toBe(renderedCanvasDigest);
        }

        await terminalCanvas.click();
        await page.keyboard.type("echo repaint");
        await expect
          .poll(async () => (await gateway.getRequests("terminal.input")).length)
          .toBeGreaterThan(0);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
      },
    );
  });
});
