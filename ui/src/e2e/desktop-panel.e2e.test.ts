import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop source panel",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

function sessionsList(placement: "local" | "active") {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        label: "Main",
        placement: { state: placement },
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

async function openPalette(page: import("playwright").Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
  });
  await page.getByRole("combobox", { name: "Search chats and commands…" }).waitFor();
}

async function openDesktopPanel(page: import("playwright").Page) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await openPalette(page);
  await page.getByRole("option", { name: "Desktop", exact: true }).click();
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator("section[aria-label='Desktop']").waitFor();
  return panel;
}

async function installDesktopClientFake(panel: import("playwright").Locator) {
  await panel.evaluate((element) => {
    (
      element as HTMLElement & {
        desktopClientFactory: () => {
          connect(options: { credentials?: { password?: string } }): Promise<{
            disconnect(): void;
          }>;
        };
      }
    ).desktopClientFactory = () => ({
      async connect(options) {
        element.dataset.connectCount = String(Number(element.dataset.connectCount ?? "0") + 1);
        element.dataset.usedCredentials = options.credentials?.password ? "true" : "false";
        return {
          disconnect() {
            element.dataset.disconnectCount = String(
              Number(element.dataset.disconnectCount ?? "0") + 1,
            );
          },
        };
      },
    });
  });
}

suite.define(() => {
  it("hides the desktop command without the method or operator.admin", async () => {
    for (const testCase of [
      {
        featureMethods: ["environments.list"],
        methodResponses: { "sessions.list": sessionsList("active") },
      },
      {
        featureMethods: ["environments.list", "desktop.observe"],
        methodResponses: { "sessions.list": sessionsList("active") },
        operatorScopes: ["operator.read"],
      },
    ]) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await installMockGateway(page, testCase);
        await page.goto(`${suite.server.baseUrl}chat`);
        await openPalette(page);
        expect(await page.getByRole("option", { name: "Desktop", exact: true }).count()).toBe(0);
      });
    }
  });

  it("keeps the desktop command and panel available without a cloud session", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["environments.list", "desktop.observe"],
        methodResponses: {
          "sessions.list": sessionsList("local"),
          "environments.list": { environments: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await openPalette(page);
      expect(await page.getByRole("option", { name: "Desktop", exact: true }).count()).toBe(1);

      await page.getByRole("option", { name: "Desktop", exact: true }).click();
      await page.locator("openclaw-desktop-panel section[aria-label='Desktop']").waitFor();
      await gateway.waitForRequest("environments.list");
    });
  });

  it("connects the host source after an in-memory VNC password prompt", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("local"),
          "environments.list": {
            environments: [
              { id: "gateway", type: "local", status: "available", desktop: true },
              {
                id: "legacy-nested-worker",
                type: "worker",
                status: "available",
                worker: {
                  providerId: "crabbox",
                  state: "ready",
                  ageMs: 1_000,
                  attachedSessionIds: [],
                  tunnelStatus: "connected",
                  desktop: true,
                },
              },
            ],
          },
          "desktop.observe": {
            transport: "rfb",
            wsPath: "/desktop/observe?token=host",
            expiresAtMs: 60_000,
            control: false,
            auth: "vnc-password",
          },
        },
      });

      const panel = await openDesktopPanel(page);
      await gateway.waitForRequest("environments.list");
      await panel.getByText("This machine", { exact: true }).waitFor();
      expect(await panel.getByText("legacy-nested-worker", { exact: true }).count()).toBe(0);
      await installDesktopClientFake(panel);

      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({ source: { kind: "host" }, control: false });
      await panel.getByText("Enter the VNC password for this machine.", { exact: true }).waitFor();
      expect(await panel.getAttribute("data-connect-count")).toBeNull();

      await panel.getByLabel("VNC password", { exact: true }).fill("memory-only-test-password");
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await expect.poll(async () => await panel.getAttribute("data-connect-count")).toBe("1");
      expect(await panel.getAttribute("data-used-credentials")).toBe("true");
      expect(await panel.getByRole("button", { name: "Browser", exact: true }).count()).toBe(0);
      expect(await panel.getByRole("button", { name: "Terminal", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
      expect(await gateway.getRequests("desktop.launch")).toHaveLength(0);
    });
  });

  it("launches advertised desktop apps and keeps observe controls working", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["desktop.launch"],
        featureMethods: ["desktop.launch", "desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
          "environments.list": {
            environments: [
              {
                id: "worker-desktop-1",
                type: "worker",
                status: "available",
                desktop: true,
                worker: {
                  providerId: "crabbox",
                  state: "attached",
                  ageMs: 1_000,
                  attachedSessionIds: ["agent:main:desktop"],
                  tunnelStatus: "connected",
                  desktopApps: ["browser", "terminal"],
                },
              },
            ],
          },
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
          "desktop.launch": { app: "browser", status: "ready" },
        },
      });

      const panel = await openDesktopPanel(page);
      await gateway.waitForRequest("environments.list");
      await panel.getByText("worker-desktop-1", { exact: true }).waitFor();
      await panel.getByText("agent:main:desktop", { exact: true }).waitFor();
      await installDesktopClientFake(panel);

      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      const viewRequest = await gateway.waitForRequest("desktop.observe");
      expect(viewRequest.params).toEqual({
        source: { kind: "environment", environmentId: "worker-desktop-1" },
        control: false,
      });
      await panel.getByText("Connecting to desktop…", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Browser", exact: true }).waitFor();
      await panel.getByRole("button", { name: "Terminal", exact: true }).waitFor();
      expect(await panel.getByText("View only", { exact: true }).count()).toBe(0);
      expect(await panel.getByText(/Controlling/).count()).toBe(0);

      const browserButton = panel.getByRole("button", { name: "Browser", exact: true });
      const terminalButton = panel.getByRole("button", { name: "Terminal", exact: true });
      expect(
        await browserButton.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe("rgba(0, 0, 0, 0)");
      const stageUsesAppBackground = await panel.evaluate((element) => {
        const stage = element.shadowRoot?.querySelector<HTMLElement>(".desktop-surface");
        if (!stage) {
          return false;
        }
        const reference = document.createElement("div");
        reference.style.background = "var(--bg)";
        element.shadowRoot?.append(reference);
        const matches =
          getComputedStyle(stage).backgroundColor === getComputedStyle(reference).backgroundColor;
        reference.remove();
        return matches;
      });
      expect(stageUsesAppBackground).toBe(true);

      await browserButton.click();
      const launchRequest = await gateway.waitForRequest("desktop.launch");
      expect(launchRequest.params).toEqual({
        source: { kind: "environment", environmentId: "worker-desktop-1" },
        app: "browser",
      });
      await expect.poll(async () => await browserButton.getAttribute("aria-busy")).toBe("true");
      expect(await terminalButton.isEnabled()).toBe(true);
      await gateway.resolveDeferred("desktop.launch", { app: "browser", status: "ready" });
      await expect.poll(async () => await browserButton.getAttribute("aria-busy")).toBe("false");

      await gateway.deferNext("desktop.launch");
      await browserButton.click();
      await gateway.waitForRequest("desktop.launch");
      await gateway.rejectDeferred("desktop.launch", {
        message: "worker desktop app launch unavailable; try again",
      });
      await panel
        .getByRole("alert")
        .filter({ hasText: "worker desktop app launch unavailable; try again" })
        .waitFor();
      await panel.getByRole("button", { name: "Browser", exact: true }).waitFor();
      expect(await browserButton.isEnabled()).toBe(true);

      await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
      await panel.getByText("Desktop sources", { exact: true }).waitFor();
      expect(
        await panel
          .getByText("worker desktop app launch unavailable; try again", { exact: true })
          .count(),
      ).toBe(0);
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("desktop.observe")).length).toBe(2);

      await panel.getByRole("button", { name: "Take control", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("desktop.observe")).length).toBe(3);
      const observeRequests = await gateway.getRequests("desktop.observe");
      expect(observeRequests[2]?.params).toEqual({
        source: { kind: "environment", environmentId: "worker-desktop-1" },
        control: true,
      });
      expect(await panel.getByRole("button", { name: "Take control", exact: true }).count()).toBe(
        0,
      );

      await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
      await panel.getByText("Desktop sources", { exact: true }).waitFor();
      expect(Number((await panel.getAttribute("data-disconnect-count")) ?? "0")).toBeGreaterThan(0);
    });
  });

  it("shows only apps advertised by the selected environment", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.launch", "desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
          "environments.list": {
            environments: [
              {
                id: "terminal-only-worker",
                type: "worker",
                status: "available",
                desktop: true,
                worker: {
                  providerId: "crabbox",
                  state: "ready",
                  ageMs: 1_000,
                  attachedSessionIds: [],
                  tunnelStatus: "connected",
                  desktopApps: ["terminal"],
                },
              },
            ],
          },
          "desktop.observe": {
            transport: "rfb",
            wsPath: "/desktop/observe?token=view",
            expiresAtMs: 60_000,
            control: false,
          },
        },
      });

      const panel = await openDesktopPanel(page);
      await gateway.waitForRequest("environments.list");
      await installDesktopClientFake(panel);
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await panel.getByRole("button", { name: "Terminal", exact: true }).waitFor();
      expect(await panel.getByRole("button", { name: "Browser", exact: true }).count()).toBe(0);
    });
  });
});
