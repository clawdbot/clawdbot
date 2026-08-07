import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "embedded terminal document",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const deadSessionScreenshotPath = process.env.OPENCLAW_TERMINAL_DEAD_SESSION_SCREENSHOT?.trim();
const deadSessionVideoDir = process.env.OPENCLAW_TERMINAL_DEAD_SESSION_VIDEO_DIR?.trim();

suite.define(() => {
  it("renders only the terminal with a tab-attached close control while native auth connects", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.addInitScript(() => {
        (
          window as Window & {
            ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: {
              gatewayUrl: string;
              token: string;
            };
          }
        )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
          gatewayUrl: "ws://gateway.example.test",
          token: "native-terminal-token",
        };
      });
      const gateway = await installMockGateway(page, {
        deferredMethods: ["connect"],
        featureMethods: ["terminal.open"],
        methodResponses: {
          "terminal.list": { sessions: [] },
          "terminal.open": {
            agentId: "main",
            confined: false,
            cwd: "/workspace",
            sessionId: "terminal-e2e",
            shell: "/bin/bash",
          },
        },
        terminalEnabled: true,
      });

      const response = await page.goto(`${suite.server.baseUrl}?view=terminal`);
      expect(response?.status()).toBe(200);
      const connect = await gateway.waitForRequest("connect");

      expect(connect.params).toMatchObject({ auth: { token: "native-terminal-token" } });
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);

      await gateway.resolveDeferred("connect");
      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({
        cols: expect.any(Number),
        rows: expect.any(Number),
      });
      const colorQueries = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\";
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "terminal-e2e",
        seq: colorQueries.length,
        data: colorQueries,
      });
      await expect.poll(async () => (await gateway.getRequests("terminal.input")).length).toBe(2);
      expect((await gateway.getRequests("terminal.input")).map(({ params }) => params)).toEqual([
        {
          sessionId: "terminal-e2e",
          data: "\u001b]10;rgb:1b1b/1e1e/2626\u001b\\",
        },
        {
          sessionId: "terminal-e2e",
          data: "\u001b]11;rgb:f7f7/f8f8/fafa\u001b\\",
        },
      ]);
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);
      const closeControlMetrics = await page
        .locator("openclaw-terminal-panel")
        .locator(".tabstrip-tab__close")
        .evaluate((close) => {
          const header = close.closest<HTMLElement>(".tp-header");
          if (!header) {
            throw new Error("Terminal close control must stay inside the tab header");
          }
          const headerBounds = header.getBoundingClientRect();
          const closeBounds = close.getBoundingClientRect();
          return {
            centerOffset: Math.abs(
              closeBounds.top +
                closeBounds.height / 2 -
                (headerBounds.top + headerBounds.height / 2),
            ),
            height: closeBounds.height,
            width: closeBounds.width,
          };
        });
      expect(closeControlMetrics.width).toBe(24);
      expect(closeControlMetrics.height).toBe(36);
      expect(closeControlMetrics.centerOffset).toBeLessThanOrEqual(0.5);
      const closeControl = page.locator("openclaw-terminal-panel").locator(".tabstrip-tab__close");
      expect(await closeControl.getAttribute("aria-label")).toBe("Close terminal session: bash");
      await closeControl.click();
      const terminalClose = await gateway.waitForRequest("terminal.close");
      expect(terminalClose.params).toEqual({ sessionId: "terminal-e2e" });
    });
  });

  it("restores a persisted session with no gateway PTY as exited", async () => {
    await suite.withPage(
      {
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        ...(deadSessionVideoDir
          ? { recordVideo: { dir: deadSessionVideoDir, size: { width: 1280, height: 800 } } }
          : {}),
      },
      async ({ page }) => {
        await page.addInitScript(() => {
          (
            window as Window & {
              ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: {
                gatewayUrl: string;
                token: string;
              };
            }
          )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
            gatewayUrl: "ws://gateway.example.test",
            token: "test",
          };
          window.sessionStorage.setItem(
            "openclaw.terminal.sessions.v1",
            JSON.stringify(["terminal-dead-after-restart"]),
          );
        });
        const gateway = await installMockGateway(page, {
          deferredMethods: ["connect"],
          featureMethods: ["terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": {
              agentId: "main",
              confined: false,
              cwd: "/workspace",
              sessionId: "replacement-terminal",
              shell: "/bin/bash",
            },
          },
          terminalEnabled: true,
        });

        const response = await page.goto(`${suite.server.baseUrl}?view=terminal`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("terminal.list");
        await page.waitForTimeout(250);

        if (deadSessionScreenshotPath) {
          await page.screenshot({ path: deadSessionScreenshotPath, fullPage: true });
        }
        const status = page.locator("openclaw-terminal-panel .tabstrip-tab__status");
        await expect
          .poll(async () => await status.textContent(), { timeout: 5_000 })
          .toBe("exited");
        expect(await gateway.getRequests("terminal.attach")).toHaveLength(0);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
        expect(
          await page.evaluate(() => window.sessionStorage.getItem("openclaw.terminal.sessions.v1")),
        ).toBe("[]");
      },
    );
  });
});
