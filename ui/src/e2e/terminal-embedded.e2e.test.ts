import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
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
  it("returns from an unavailable focused terminal", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator("openclaw-app-shell").waitFor();
      await page.goto(`${suite.server.baseUrl}?view=terminal`);

      await page.waitForURL(`${suite.server.baseUrl}focus/terminal`);
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

      await page
        .getByText("The terminal is not available on this gateway.", { exact: true })
        .waitFor();
      const back = page.getByRole("button", { name: "Back", exact: true });
      await back.waitFor();
      await back.click();
      await page.waitForURL(`${suite.server.baseUrl}dashboards`);
    });
  });

  it("fences an SW-less stale build before it can restore an ownerless terminal", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gatewayUrl = suite.server.baseUrl.replace(/^http/u, "ws");
      await page.addInitScript((url) => {
        (
          window as Window & {
            ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
          }
        )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
          gatewayUrl: url,
          token: "native-build-identity-token",
        };
      }, gatewayUrl);
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
        serverBuildId: "replacement-build",
        terminalEnabled: true,
      });

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      const firstConnect = await gateway.waitForRequest("connect");
      expect(firstConnect.params).toMatchObject({ client: { buildId: "e2e" } });
      await page.waitForFunction(
        () =>
          sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId") ===
          "replacement-build",
      );
      await page.getByText("Server updated", { exact: true }).waitFor();

      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      expect(
        await page.locator("openclaw-terminal-panel").evaluate((element) => {
          return (element as HTMLElement & { available: boolean }).available;
        }),
      ).toBe(false);
    });
  });

  it("keeps an independently built same-origin Control UI connected", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gatewayUrl = suite.server.baseUrl.replace(/^http/u, "ws");
      await page.addInitScript((url) => {
        (
          window as Window & {
            ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
          }
        )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
          gatewayUrl: url,
          token: "native-configured-ui-token",
        };
      }, gatewayUrl);
      const gateway = await installMockGateway(page, {
        assistantAgentId: "main",
        controlUiBuildSource: "configured",
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
        methodResponses: {
          "terminal.open": {
            agentId: "main",
            confined: false,
            cwd: "/workspace",
            sessionId: "configured-ui-terminal",
            shell: "/bin/bash",
          },
        },
        serverBuildId: "independent-build",
        serverVersion: "2026.7.20",
        terminalEnabled: true,
      });

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("connect");
      await page.waitForFunction(() => {
        const panel = document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { available: boolean })
          | null;
        return panel?.available === true;
      });
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: { agentId: "main", open: true },
          }),
        );
      });

      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({ agentId: "main" });
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId"),
        ),
      ).toBeNull();
    });
  });

  it("opens a new dock terminal for a selection changed without navigation", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantAgentId: "main",
        defaultAgentId: "main",
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", identity: { name: "Main" }, name: "Main" },
              { id: "research", identity: { name: "Research" }, name: "Research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          // The startup projection owns the roster when chat.startup is
          // advertised, so the second agent must arrive through it.
          "chat.startup": {
            agentsList: {
              agents: [
                { id: "main", identity: { name: "Main" }, name: "Main" },
                { id: "research", identity: { name: "Research" }, name: "Research" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            messages: [],
            sessionId: "terminal-selection-e2e-session",
          },
          "terminal.open": {
            agentId: "research",
            confined: false,
            cwd: "/workspace/research",
            sessionId: "terminal-selection-e2e",
            shell: "/bin/bash",
          },
        },
        terminalEnabled: true,
      });

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("connect");
      await gateway.waitForRequest("chat.startup");
      await page.waitForFunction(() => {
        const panel = document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { available: boolean })
          | null;
        const shell = document.querySelector("openclaw-app-shell") as
          | (HTMLElement & {
              runtime?: { context?: { agentSelection?: { set: (agentId: string) => void } } };
            })
          | null;
        return (
          customElements.get("openclaw-terminal-panel") !== undefined &&
          panel?.available &&
          typeof shell?.runtime?.context?.agentSelection?.set === "function"
        );
      });
      await page.evaluate(() => {
        const shell = document.querySelector("openclaw-app-shell") as HTMLElement & {
          runtime?: { context?: { agentSelection?: { set: (agentId: string) => void } } };
        };
        const setAgent = shell.runtime?.context?.agentSelection?.set;
        if (!setAgent) {
          throw new Error("Agent selection is not ready");
        }
        setAgent("research");
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: { agentId: "research", open: true },
          }),
        );
      });

      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({ agentId: "research" });
    });
  });

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
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
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

      const response = await page.goto(`${suite.server.baseUrl}focus/terminal`);
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
      const colorQueries = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b]12;?\u001b\\";
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "terminal-e2e",
        seq: colorQueries.length,
        data: colorQueries,
      });
      await expect.poll(async () => (await gateway.getRequests("terminal.input")).length).toBe(3);
      const themeColors = await page.evaluate(() => {
        const styles = getComputedStyle(document.documentElement);
        return ["--text", "--bg", "--accent"].map((property) =>
          styles.getPropertyValue(property).trim(),
        );
      });
      expect((await gateway.getRequests("terminal.input")).map(({ params }) => params)).toEqual(
        themeColors.map((color, index) => ({
          sessionId: "terminal-e2e",
          data: `\u001b]${index + 10};rgb:${[1, 3, 5]
            .map((offset) => color.slice(offset, offset + 2).repeat(2))
            .join("/")}\u001b\\`,
        })),
      );
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);
      const closeControlMetrics = await page
        .locator("openclaw-terminal-panel")
        .locator(".tabstrip-tab__close")
        .evaluate((close) => {
          const header = close.closest<HTMLElement>(".tp-header");
          const tab = close.previousElementSibling;
          const tabBase = tab?.shadowRoot?.querySelector<HTMLElement>("[part~='base']");
          if (!header) {
            throw new Error("Terminal close control must stay inside the tab header");
          }
          if (!tabBase) {
            throw new Error("Terminal close control must follow a rendered tab surface");
          }
          const headerBounds = header.getBoundingClientRect();
          const closeBounds = close.getBoundingClientRect();
          const tabBounds = tabBase.getBoundingClientRect();
          const closeStyle = getComputedStyle(close);
          const tabStyle = getComputedStyle(tabBase);
          return {
            backgroundColor: tabStyle.backgroundColor,
            borderBottomWidth: tabStyle.borderBottomWidth,
            borderRadius: tabStyle.borderRadius,
            closeBorderBottomWidth: closeStyle.borderBottomWidth,
            centerOffset: Math.abs(
              closeBounds.top +
                closeBounds.height / 2 -
                (headerBounds.top + headerBounds.height / 2),
            ),
            closeInset: tabBounds.right - closeBounds.right,
            height: closeBounds.height,
            tabHeight: tabBounds.height,
            width: closeBounds.width,
          };
        });
      expect(closeControlMetrics.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(closeControlMetrics.borderBottomWidth).toBe("0px");
      expect(closeControlMetrics.borderRadius).not.toBe("0px");
      expect(closeControlMetrics.closeBorderBottomWidth).toBe("0px");
      expect(closeControlMetrics.closeInset).toBeGreaterThanOrEqual(-0.5);
      expect(closeControlMetrics.tabHeight).toBe(30);
      expect(closeControlMetrics.width).toBe(28);
      expect(closeControlMetrics.height).toBe(28);
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
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
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

        const response = await page.goto(`${suite.server.baseUrl}focus/terminal`);
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
