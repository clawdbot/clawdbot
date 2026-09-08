import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const realVncWsUrl = process.env.OPENCLAW_DESKTOP_REAL_VNC_WS_URL?.trim() || null;
const suite = createControlUiE2eSuite({
  name: "desktop fullscreen",
  browserLaunchOptions: realVncWsUrl
    ? { args: ["--disable-web-security", "--allow-running-insecure-content"] }
    : undefined,
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofStage = process.env.OPENCLAW_DESKTOP_FULLSCREEN_PROOF_STAGE ?? "after";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("desktop-fullscreen");
  }
});

function sessionsList() {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        label: "Main",
        placement: { state: "active" },
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

const workerDesktopEnvironment = {
  id: "worker-desktop-1",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "crabbox",
    state: "attached",
    ageMs: 1_000,
    attachedSessionIds: ["agent:main:release-operations"],
    tunnelStatus: "connected",
    desktopApps: ["browser", "terminal"],
  },
} as const;

async function openDesktopPanel(page: Page) {
  await page.goto(`${suite.server.baseUrl}activity`);
  await waitForControlUiGatewayReady(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
  });
  await page.getByRole("combobox", { name: "Search chats and commands…" }).waitFor();
  await page.getByRole("option", { name: "Desktop", exact: true }).click();
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator("section[aria-label='Desktop']").waitFor();
  return panel;
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((nextTheme) => {
    document.documentElement.dataset.themeMode = nextTheme;
    document.documentElement.dataset.themeResolved = nextTheme;
    document.documentElement.classList.toggle("wa-light", nextTheme === "light");
    document.documentElement.classList.toggle("wa-dark", nextTheme === "dark");
    document.documentElement.style.colorScheme = nextTheme;
  }, theme);
}

async function captureDesktopProof(page: Page, panel: import("playwright").Locator, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(proofDir, `${proofStage}-${name}-context.png`),
  });
  await panel.locator(".bp-header").screenshot({
    animations: "disabled",
    path: path.join(proofDir, `${proofStage}-${name}-header.png`),
  });
  const connectionToolbar = panel.locator(".desktop-toolbar--connection");
  if ((await connectionToolbar.count()) > 0) {
    await connectionToolbar.screenshot({
      animations: "disabled",
      path: path.join(proofDir, `${proofStage}-${name}-controls.png`),
    });
  }
}

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "keeps the production noVNC canvas mounted through fullscreen entry and exit in %s mode",
    async (theme) => {
      await suite.withPage(
        {
          colorScheme: theme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: ["desktop.observe", "environments.list"],
            webSocketPassthroughPrefixes: realVncWsUrl ? [realVncWsUrl] : [],
            methodResponses: {
              "sessions.list": sessionsList(),
              "environments.list": { environments: [workerDesktopEnvironment] },
              "desktop.observe": {
                cases: [
                  {
                    match: {
                      source: { kind: "environment", environmentId: "worker-desktop-1" },
                      control: false,
                    },
                    response: {
                      transport: "rfb",
                      wsPath: realVncWsUrl ?? "/desktop/observe?token=view",
                      expiresAtMs: 60_000,
                      control: false,
                    },
                  },
                  {
                    match: {
                      source: { kind: "environment", environmentId: "worker-desktop-1" },
                      control: true,
                    },
                    response: {
                      transport: "rfb",
                      wsPath: realVncWsUrl ?? "/desktop/observe?token=control",
                      expiresAtMs: 60_000,
                      control: true,
                    },
                  },
                ],
              },
            },
          });
          const panel = await openDesktopPanel(page);
          await setTheme(page, theme);
          await gateway.waitForRequest("environments.list");
          if (!realVncWsUrl) {
            // CI uses the canonical scripted RFB endpoint. Visual proof sets
            // OPENCLAW_DESKTOP_REAL_VNC_WS_URL to a genuine VNC desktop.
            await installScriptedRfbServer(page);
          }
          await panel.getByRole("button", { name: "Connect", exact: true }).click();
          const screen = panel.locator(".desktop-surface canvas");
          await screen.waitFor();
          if (realVncWsUrl) {
            await expect
              .poll(
                () =>
                  screen.evaluate((element) => {
                    const canvas = element as HTMLCanvasElement;
                    const context = canvas.getContext("2d");
                    if (!context || canvas.width === 0 || canvas.height === 0) {
                      return false;
                    }
                    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    for (let index = 0; index < pixels.length; index += 128) {
                      if (
                        (pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0) >
                        0
                      ) {
                        return true;
                      }
                    }
                    return false;
                  }),
                { timeout: 15_000 },
              )
              .toBe(true);
          }

          await captureDesktopProof(page, panel, `${theme}-default`);
          expect(
            await page.evaluate(() => ({
              enabled: document.fullscreenEnabled,
              requestType: typeof Element.prototype.requestFullscreen,
            })),
          ).toEqual({ enabled: true, requestType: "function" });
          const fullscreenButton = panel.locator(".desktop-fullscreen-button");
          expect(await fullscreenButton.getAttribute("aria-label")).toBe("Enter fullscreen");
          await fullscreenButton.hover();
          await captureDesktopProof(page, panel, `${theme}-hover`);
          await fullscreenButton.focus();
          await captureDesktopProof(page, panel, `${theme}-focus`);

          const screenHandle = await screen.elementHandle();
          await fullscreenButton.press("Enter");
          await expect
            .poll(() => fullscreenButton.getAttribute("aria-label"))
            .toBe("Exit fullscreen");
          expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
          expect(
            await screen.evaluate((element, original) => element === original, screenHandle),
          ).toBe(true);
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
          expect(
            await panel.getByRole("button", { name: "Take control", exact: true }).isVisible(),
          ).toBe(true);
          expect(
            await panel.getByRole("button", { name: "Disconnect", exact: true }).isVisible(),
          ).toBe(true);
          const [stageBox, screenBox] = await Promise.all([
            panel.locator(".desktop-stage").boundingBox(),
            screen.boundingBox(),
          ]);
          if (!stageBox || !screenBox) {
            throw new Error("Desktop fullscreen geometry is unavailable");
          }
          const framebuffer = await screen.evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            return { height: canvas.height, width: canvas.width };
          });
          expect(framebuffer.width).toBeGreaterThan(0);
          expect(framebuffer.height).toBeGreaterThan(0);
          expect(
            Math.abs(screenBox.width / screenBox.height - framebuffer.width / framebuffer.height),
          ).toBeLessThan(0.02);
          expect(screenBox.x).toBeGreaterThanOrEqual(stageBox.x);
          expect(screenBox.y).toBeGreaterThanOrEqual(stageBox.y);
          expect(screenBox.x + screenBox.width).toBeLessThanOrEqual(stageBox.x + stageBox.width);
          expect(screenBox.y + screenBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height);
          expect(
            stageBox.width - screenBox.width > 20 || stageBox.height - screenBox.height > 20,
          ).toBe(true);
          await captureDesktopProof(page, panel, `${theme}-fullscreen`);

          await panel.getByRole("button", { name: "Take control", exact: true }).click();
          await expect
            .poll(async () => (await gateway.getRequests("desktop.observe")).length)
            .toBe(2);
          expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
          // The authenticated handoff keeps both canvases until the replacement connects.
          await expect
            .poll(() => screenHandle?.evaluate((element) => element.isConnected))
            .toBe(false);
          await screen.waitFor();
          await expect
            .poll(() => panel.getByRole("button", { name: "Take control", exact: true }).count())
            .toBe(0);

          // Escape and browser controls both exit through the fullscreenchange path.
          await page.evaluate(() => document.exitFullscreen());
          await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
          await expect
            .poll(() => fullscreenButton.getAttribute("aria-label"))
            .toBe("Enter fullscreen");
          expect(
            await fullscreenButton.evaluate(
              (button) => button === (button.getRootNode() as ShadowRoot).activeElement,
            ),
          ).toBe(true);
          await captureDesktopProof(page, panel, `${theme}-exit`);

          await fullscreenButton.click();
          await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
          await panel.getByText("Desktop sources", { exact: true }).waitFor();
          expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
          await captureDesktopProof(page, panel, `${theme}-disconnected-fullscreen`);
          await fullscreenButton.click();
          await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
        },
      );
    },
  );

  it("reports unavailable and denied fullscreen requests", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList(),
          "environments.list": { environments: [] },
        },
      });
      const panel = await openDesktopPanel(page);
      const button = panel.locator(".desktop-fullscreen-button");
      await panel.locator("section.bp").evaluate((element) => {
        element.requestFullscreen = () =>
          Promise.reject(new DOMException("Fullscreen permission denied", "NotAllowedError"));
      });
      await button.click();
      await panel
        .getByRole("alert")
        .filter({ hasText: "Could not change fullscreen mode: Fullscreen permission denied" })
        .waitFor();

      await page.evaluate(() => {
        Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
      });
      await panel.evaluate((element) =>
        (element as HTMLElement & { requestUpdate(): void }).requestUpdate(),
      );
      await expect
        .poll(() => button.getAttribute("aria-label"))
        .toBe("Fullscreen is unavailable in this browser");
      expect(await button.getAttribute("aria-disabled")).toBe("true");
      await button.focus();
      await button.press("Enter");
      await panel
        .getByRole("alert")
        .filter({ hasText: "Fullscreen is unavailable in this browser" })
        .waitFor();
    });
  });

  it("exits fullscreen when the desktop panel unmounts", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList(),
          "environments.list": { environments: [] },
        },
      });
      const panel = await openDesktopPanel(page);
      await panel.locator(".desktop-fullscreen-button").click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
      await panel.evaluate((element) => element.remove());
      await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    });
  });
});
