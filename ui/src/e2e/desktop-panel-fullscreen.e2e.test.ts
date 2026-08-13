import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop fullscreen",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofStage = process.env.OPENCLAW_DESKTOP_FULLSCREEN_PROOF_STAGE ?? "after";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "desktop-fullscreen");

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
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
  });
  await page.getByRole("combobox", { name: "Search chats and commands…" }).waitFor();
  await page.getByRole("option", { name: "Desktop", exact: true }).click();
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator("section[aria-label='Desktop']").waitFor();
  return panel;
}

async function installRichDesktopClientFake(panel: import("playwright").Locator) {
  await panel.evaluate((element) => {
    type Options = {
      onConnect?: () => void;
      onDisconnect?: (detail: { code?: number; reason?: string }) => void;
      target: HTMLElement;
      viewOnly: boolean;
    };
    (
      element as HTMLElement & {
        desktopClientFactory: () => {
          connect(options: Options): Promise<{ disconnect(): void }>;
        };
        triggerDesktopDisconnect?: () => void;
      }
    ).desktopClientFactory = () => ({
      async connect(options) {
        const screen = document.createElement("div");
        screen.dataset.testid = "rich-desktop-screen";
        screen.style.cssText = [
          "aspect-ratio:16/10",
          "background:linear-gradient(145deg,#172554,#0f766e)",
          "border:1px solid rgba(255,255,255,.24)",
          "border-radius:10px",
          "box-shadow:0 20px 48px rgba(0,0,0,.35)",
          "color:#f8fafc",
          "display:grid",
          "font:13px ui-sans-serif,system-ui",
          "grid-template-rows:34px 1fr 28px",
          "height:min(90%,620px)",
          "margin:auto",
          "overflow:hidden",
          "width:min(90%,992px)",
        ].join(";");
        screen.innerHTML = `
          <div style="align-items:center;background:rgba(15,23,42,.88);display:flex;gap:7px;padding:0 12px">
            <span style="background:#fb7185;border-radius:50%;height:8px;width:8px"></span>
            <span style="background:#fbbf24;border-radius:50%;height:8px;width:8px"></span>
            <span style="background:#34d399;border-radius:50%;height:8px;width:8px"></span>
            <strong style="margin-left:6px">Release operations · worker-desktop-1</strong>
            <span style="margin-left:auto;opacity:.72">Secure observer</span>
          </div>
          <div style="display:grid;gap:14px;grid-template-columns:1.35fr .65fr;padding:18px">
            <div style="background:rgba(15,23,42,.76);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:16px">
              <div style="font-size:18px;font-weight:700;margin-bottom:12px">Production rollout</div>
              <div style="background:#22c55e;border-radius:999px;height:7px;margin:10px 0;width:78%"></div>
              <div style="display:grid;gap:8px;grid-template-columns:repeat(3,1fr);margin-top:18px">
                <div style="background:rgba(255,255,255,.09);border-radius:7px;padding:12px">12 healthy</div>
                <div style="background:rgba(255,255,255,.09);border-radius:7px;padding:12px">2 pending</div>
                <div style="background:rgba(255,255,255,.09);border-radius:7px;padding:12px">0 failed</div>
              </div>
            </div>
            <div style="background:rgba(15,23,42,.76);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:16px">
              <strong>Live checks</strong>
              <p>Gateway ✓</p><p>Desktop relay ✓</p><p>Browser session ✓</p>
            </div>
          </div>
          <div style="align-items:center;background:rgba(15,23,42,.9);display:flex;justify-content:space-between;padding:0 12px">
            <span>operator@worker-desktop-1</span><span>${options.viewOnly ? "View only" : "Control enabled"}</span>
          </div>`;
        options.target.replaceChildren(screen);
        (
          element as HTMLElement & { triggerDesktopDisconnect?: () => void }
        ).triggerDesktopDisconnect = () =>
          options.onDisconnect?.({ code: 1006, reason: "remote session ended" });
        options.onConnect?.();
        return { disconnect: () => screen.remove() };
      },
    });
  });
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
  await mkdir(proofDir, { recursive: true });
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
    "keeps the active desktop surface mounted through fullscreen entry and exit in %s mode",
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
                      wsPath: "/desktop/observe?token=view",
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
                      wsPath: "/desktop/observe?token=control",
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
          await installRichDesktopClientFake(panel);
          await panel.getByRole("button", { name: "Connect", exact: true }).click();
          await panel.getByTestId("rich-desktop-screen").waitFor();

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

          const screen = panel.getByTestId("rich-desktop-screen");
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
          expect(Math.abs(screenBox.width / screenBox.height - 16 / 10)).toBeLessThan(0.02);
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
          await panel.getByText("Control enabled", { exact: true }).waitFor();

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
          await panel.getByRole("button", { name: "Connect", exact: true }).click();
          await panel.getByText("View only", { exact: true }).waitFor();
          await panel.evaluate((element) => {
            (
              element as HTMLElement & { triggerDesktopDisconnect?: () => void }
            ).triggerDesktopDisconnect?.();
          });
          await panel
            .getByText("Desktop disconnected: remote session ended", { exact: true })
            .waitFor();
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
