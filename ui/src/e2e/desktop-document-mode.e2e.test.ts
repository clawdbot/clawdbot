import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop document mode",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const artifactDirectory = path.resolve(".artifacts/mobile-desktop");
const gatewayEnvironment = {
  id: "gateway",
  type: "local",
  status: "available",
  desktop: true,
};

type FakeDesktopConnectOptions = {
  onConnect?: () => void;
  scaleViewport?: boolean;
  target: HTMLElement;
  viewOnly: boolean;
};

async function installDesktopClientFake(panel: import("playwright").Locator) {
  await panel.evaluate((element) => {
    (
      element as HTMLElement & {
        desktopClientFactory: () => {
          connect(options: FakeDesktopConnectOptions): Promise<{
            disconnect(): void;
            sendBackspace(): void;
            sendKeyboardEvent(event: KeyboardEvent): void;
            sendText(text: string): void;
            setScaleViewport(enabled: boolean): void;
          }>;
        };
      }
    ).desktopClientFactory = () => ({
      async connect(options) {
        element.dataset.viewOnly = String(options.viewOnly);
        element.dataset.scaleViewport = String(options.scaleViewport ?? true);
        const remote = document.createElement("div");
        remote.dataset.testRemoteDesktop = "true";
        remote.textContent = "Remote desktop";
        remote.style.cssText =
          "display:grid;place-items:center;width:100%;height:100%;color:#e8edf5;background:linear-gradient(145deg,#26364d,#111823);font:600 18px system-ui";
        options.target.replaceChildren(remote);
        options.onConnect?.();
        return {
          disconnect() {
            remote.remove();
          },
          sendKeyboardEvent(event) {
            element.dataset.lastKeyboardEvent = `${event.type}:${event.key}`;
          },
          sendText(text) {
            element.dataset.lastKeyboardText = text;
          },
          sendBackspace() {
            element.dataset.lastKeyboardText = "Backspace";
          },
          setScaleViewport(enabled) {
            element.dataset.scaleViewport = String(enabled);
          },
        };
      },
    });
  });
}

async function startDesktopDocument(
  page: import("playwright").Page,
  route: string,
  desktopObserve: unknown = {
    transport: "rfb",
    wsPath: "/desktop/observe?token=document",
    expiresAtMs: 60_000,
    control: false,
  },
) {
  await page.setViewportSize({ width: 390, height: 844 });
  const gateway = await installMockGateway(page, {
    deferredMethods: ["environments.list"],
    featureMethods: ["desktop.observe", "environments.list", "openclaw.setup.detect"],
    methodResponses: {
      "desktop.observe": desktopObserve,
      "openclaw.setup.detect": {
        candidates: [],
        manualProviders: [],
        workspace: "/tmp/openclaw-desktop-document",
        setupComplete: false,
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}${route}`);
  const panel = page.locator("openclaw-desktop-panel");
  await panel.waitFor({ state: "attached" });
  await gateway.waitForRequest("environments.list");
  await installDesktopClientFake(panel);
  return { gateway, panel };
}

async function openDesktopDocument(
  page: import("playwright").Page,
  route: string,
  environments: unknown[],
  desktopObserve?: unknown,
) {
  const document = await startDesktopDocument(page, route, desktopObserve);
  await document.gateway.resolveDeferred("environments.list", { environments });
  return document;
}

suite.define(() => {
  it.each([
    ["the query route", "?view=desktop"],
    ["the path route", "desktop"],
  ])("renders a full-bleed shell-free picker from %s", async (_label, route) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { panel } = await openDesktopDocument(page, route, [gatewayEnvironment]);
      const viewer = panel.locator("section.desktop-document");
      await viewer.waitFor();
      await panel.getByText("Desktop sources", { exact: true }).waitFor();

      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(page.url()).not.toContain("model-setup");
      const bounds = await viewer.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(389);
      expect(bounds?.height).toBeGreaterThanOrEqual(843);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      if (route === "?view=desktop") {
        await mkdir(artifactDirectory, { recursive: true });
        await page.screenshot({
          path: path.join(artifactDirectory, "picker-390x844.png"),
          fullPage: false,
        });
      }
    });
  });

  it("falls back to the picker with a notice for an unobservable source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "?view=desktop&source=missing-machine",
        [gatewayEnvironment],
      );

      await panel
        .getByText("The requested desktop source is unavailable. Choose another source.", {
          exact: true,
        })
        .waitFor();
      await panel.getByText("Desktop sources", { exact: true }).waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
    });
  });

  it("renders inventory failure recovery and retries the preselected source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await startDesktopDocument(page, "?view=desktop&source=gateway");
      await gateway.rejectDeferred("environments.list", {
        code: "UNAVAILABLE",
        message: "desktop inventory is temporarily unavailable",
      });

      await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
      const retry = panel.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);

      await gateway.setMethodResponse("environments.list", {
        environments: [gatewayEnvironment],
      });
      await retry.click();
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({ source: { kind: "host" }, control: false });
      await panel.locator("[data-test-remote-desktop='true']").waitFor();
    });
  });

  it("auto-connects view-only and provides four working touch actions", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "?view=desktop&source=gateway",
        [gatewayEnvironment],
        {
          sequence: [
            {
              transport: "rfb",
              wsPath: "/desktop/observe?token=view",
              expiresAtMs: 60_000,
              control: false,
            },
            {
              transport: "rfb",
              wsPath: "/desktop/observe?token=control",
              expiresAtMs: 60_000,
              control: true,
            },
          ],
        },
      );

      const viewRequest = await gateway.waitForRequest("desktop.observe");
      expect(viewRequest.params).toEqual({ source: { kind: "host" }, control: false });
      await expect.poll(() => panel.getAttribute("data-view-only")).toBe("true");
      const touchActions = panel.locator(".desktop-touch-action");
      await expect.poll(() => touchActions.count()).toBe(4);
      await panel.getByRole("button", { name: "Back", exact: true }).waitFor();

      await panel.getByRole("button", { name: "Take control", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("desktop.observe")).length).toBe(2);
      expect((await gateway.getRequests("desktop.observe"))[1]?.params).toEqual({
        source: { kind: "host" },
        control: true,
      });
      await expect.poll(() => panel.getAttribute("data-view-only")).toBe("false");

      await panel.getByRole("button", { name: "Use actual size", exact: true }).click();
      await expect.poll(() => panel.getAttribute("data-scale-viewport")).toBe("false");

      await panel.getByRole("button", { name: "Keyboard", exact: true }).click();
      expect(
        await panel.evaluate((element) =>
          element.shadowRoot?.activeElement?.classList.contains("desktop-keyboard-input"),
        ),
      ).toBe(true);
      await page.keyboard.type("k");
      await expect.poll(() => panel.getAttribute("data-last-keyboard-event")).toBe("keyup:k");
      await panel.locator(".desktop-keyboard-input").evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        input.value += "m";
        input.dispatchEvent(
          new InputEvent("input", { data: "m", inputType: "insertText", bubbles: true }),
        );
      });
      await expect.poll(() => panel.getAttribute("data-last-keyboard-text")).toBe("m");

      await mkdir(artifactDirectory, { recursive: true });
      await page.screenshot({
        path: path.join(artifactDirectory, "connected-toolbar-390x844.png"),
        fullPage: false,
      });
    });
  });

  it("applies only control=1 as the initial control request", async () => {
    for (const [value, expected] of [
      ["1", true],
      ["true", false],
    ] as const) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { gateway } = await openDesktopDocument(
          page,
          `?view=desktop&source=gateway&control=${value}`,
          [gatewayEnvironment],
          {
            transport: "rfb",
            wsPath: `/desktop/observe?token=control-${value}`,
            expiresAtMs: 60_000,
            control: expected,
          },
        );
        const request = await gateway.waitForRequest("desktop.observe");
        expect(request.params).toEqual({ source: { kind: "host" }, control: expected });
      });
    }
  });
});
