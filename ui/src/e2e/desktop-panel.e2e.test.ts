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

const workerDesktopEnvironment = {
  id: "worker-desktop-1",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "crabbox",
    state: "attached",
    ageMs: 1_000,
    attachedSessionIds: ["main"],
    tunnelStatus: "connected",
    desktopApps: ["browser", "terminal"],
  },
} as const;

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

async function openDirectDesktop(page: import("playwright").Page, environmentId: string) {
  await page.evaluate((targetEnvironmentId) => {
    window.dispatchEvent(
      new CustomEvent("openclaw:desktop-toggle", {
        detail: { open: true, environmentId: targetEnvironmentId },
      }),
    );
  }, environmentId);
}

async function installDesktopClientFake(panel: import("playwright").Locator) {
  await panel.evaluate((element) => {
    (
      element as HTMLElement & {
        desktopClientFactory: () => {
          connect(options: { credentials?: { username?: string; password?: string } }): Promise<{
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
      const panel = page.locator("openclaw-desktop-panel");
      await panel.locator("section[aria-label='Desktop']").waitFor();
      await panel.getByText("Desktop sources", { exact: true }).waitFor();
      await gateway.waitForRequest("environments.list");
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
    });
  });

  it("refreshes direct-target inventory before observing the exact worker", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.launch", "desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
          "environments.list": {
            environments: [workerDesktopEnvironment],
          },
          "desktop.observe": {
            transport: "rfb",
            wsPath: "/desktop/observe?token=direct",
            expiresAtMs: 60_000,
            control: false,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const panel = page.locator("openclaw-desktop-panel");
      await installDesktopClientFake(panel);
      const requestCount = (await gateway.getRequests()).length;

      await openDirectDesktop(page, "worker-desktop-1");

      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({
        source: { kind: "environment", environmentId: "worker-desktop-1" },
        control: false,
      });
      expect(
        (await gateway.getRequests())
          .slice(requestCount)
          .filter((request) => ["environments.list", "desktop.observe"].includes(request.method))
          .map((request) => request.method),
      ).toEqual(["environments.list", "desktop.observe"]);
      expect(await panel.getByText("Desktop sources", { exact: true }).count()).toBe(0);
      await panel.getByRole("button", { name: "Browser", exact: true }).waitFor();
      await panel.getByRole("button", { name: "Terminal", exact: true }).waitFor();
    });
  });

  it("reports an unavailable direct target without showing another source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
          "environments.list": {
            environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
          },
          "desktop.observe": {
            __mockError: {
              code: "UNAVAILABLE",
              message: "requested worker desktop is temporarily unavailable",
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);

      await openDirectDesktop(page, "missing-worker");

      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({
        source: { kind: "environment", environmentId: "missing-worker" },
        control: false,
      });
      const panel = page.locator("openclaw-desktop-panel");
      await panel.getByText(/requested worker desktop is temporarily unavailable/).waitFor();
      expect(await panel.getByText("Desktop sources", { exact: true }).count()).toBe(0);
      expect(await panel.getByText("This machine", { exact: true }).count()).toBe(0);
    });
  });

  it("shows direct-target inventory failure without observing or falling back", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
          "environments.list": {
            __mockError: {
              code: "UNAVAILABLE",
              message: "desktop inventory is temporarily unavailable",
            },
          },
          "desktop.observe": {
            transport: "rfb",
            wsPath: "/desktop/observe?token=degraded",
            expiresAtMs: 60_000,
            control: false,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await openDirectDesktop(page, "worker-desktop-1");

      const panel = page.locator("openclaw-desktop-panel");
      await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      expect(await panel.getByText("Desktop sources", { exact: true }).count()).toBe(0);
      expect(await panel.getByText("This machine", { exact: true }).count()).toBe(0);

      await gateway.setMethodResponse("environments.list", {
        environments: [workerDesktopEnvironment],
      });
      await installDesktopClientFake(panel);
      const requestCount = (await gateway.getRequests()).length;
      await panel.getByRole("button", { name: "Retry", exact: true }).click();

      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(2);
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({
        source: { kind: "environment", environmentId: "worker-desktop-1" },
        control: false,
      });
      expect(
        (await gateway.getRequests())
          .slice(requestCount)
          .filter((request) => ["environments.list", "desktop.observe"].includes(request.method))
          .map((request) => request.method),
      ).toEqual(["environments.list", "desktop.observe"]);
      await panel.getByRole("button", { name: "Browser", exact: true }).waitFor();
      await panel.getByRole("button", { name: "Terminal", exact: true }).waitFor();
      expect(await panel.getAttribute("data-connect-count")).toBe("1");
      expect(await panel.getByText("Desktop sources", { exact: true }).count()).toBe(0);
    });
  });

  it("does not observe a direct target after its inventory refresh is closed", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
          "environments.list": { environments: [] },
          "desktop.observe": {
            transport: "rfb",
            wsPath: "/desktop/observe?token=stale",
            expiresAtMs: 60_000,
            control: false,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("environments.list");
      const inventoryCount = (await gateway.getRequests("environments.list")).length;

      await openDirectDesktop(page, "worker-desktop-1");
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(inventoryCount + 1);
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:desktop-toggle", { detail: { open: false } }),
        );
      });
      await gateway.resolveDeferred("environments.list", { environments: [] });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(
        await page.locator("openclaw-desktop-panel section[aria-label='Desktop']").count(),
      ).toBe(0);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
    });
  });

  it("keeps a right-docked desktop above bottom-docked panels", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["environments.list", "desktop.observe"],
        methodResponses: {
          "sessions.list": sessionsList("local"),
          "environments.list": { environments: [] },
        },
      });
      const panel = await openDesktopPanel(page);
      await panel.getByRole("button", { name: "Dock to right", exact: true }).click();
      const bottom = await panel.evaluate((element) => {
        document.documentElement.style.setProperty("--oc-terminal-reserve-bottom", "40px");
        document.documentElement.style.setProperty("--oc-browser-reserve-bottom", "80px");
        const section = element.shadowRoot?.querySelector<HTMLElement>(".bp--right");
        return section ? getComputedStyle(section).bottom : null;
      });
      expect(bottom).toBe("120px");
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
            sequence: [
              {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "VNC password is required to observe this machine",
                  details: {
                    code: "DESKTOP_CREDENTIALS_REQUIRED",
                    auth: "vnc-password",
                  },
                },
              },
              {
                transport: "rfb",
                wsPath: "/desktop/observe?token=host",
                expiresAtMs: 60_000,
                control: false,
                auth: "vnc-password",
              },
            ],
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
      const observeRequests = await gateway.getRequests("desktop.observe");
      expect(observeRequests).toHaveLength(2);
      expect(observeRequests[1]?.params).toEqual({
        source: { kind: "host" },
        control: false,
        credentials: { password: "memory-only-test-password" },
      });
      expect(await gateway.getRequests("desktop.launch")).toHaveLength(0);
    });
  });

  it("retries host observe with ARD credentials without passing them to noVNC", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("local"),
          "environments.list": {
            environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
          },
          "desktop.observe": {
            sequence: [
              {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "macOS account credentials are required to observe Screen Sharing",
                  details: {
                    code: "DESKTOP_CREDENTIALS_REQUIRED",
                    auth: "ard-account",
                  },
                },
              },
              {
                transport: "rfb",
                wsPath: "/desktop/observe?token=ard-host",
                expiresAtMs: 60_000,
                control: false,
                auth: "ard-account",
              },
            ],
          },
        },
      });

      const panel = await openDesktopPanel(page);
      await gateway.waitForRequest("environments.list");
      await installDesktopClientFake(panel);
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await panel
        .getByText("Enter a macOS account to authenticate Screen Sharing.", { exact: true })
        .waitFor();
      expect((await gateway.getRequests("desktop.observe"))[0]?.params).toEqual({
        source: { kind: "host" },
        control: false,
      });

      await panel.getByLabel("macOS username", { exact: true }).fill("operator");
      await panel
        .getByLabel("macOS password", { exact: true })
        .fill("memory-only-account-password");
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await expect.poll(async () => await panel.getAttribute("data-connect-count")).toBe("1");
      expect(await panel.getAttribute("data-used-credentials")).toBe("false");
      const requests = await gateway.getRequests("desktop.observe");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.params).toEqual({
        source: { kind: "host" },
        control: false,
        credentials: { username: "operator", password: "memory-only-account-password" },
      });
    });
  });

  it("lists an observable node and connects with the node source arm", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("local"),
          "environments.list": {
            environments: [
              {
                id: "node:paired-node",
                type: "node",
                status: "available",
                desktop: true,
                capabilities: ["desktop.stream"],
              },
              {
                id: "node:plain-node",
                type: "node",
                status: "available",
                capabilities: ["screen.snapshot"],
              },
            ],
          },
          "desktop.observe": {
            sequence: [
              {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "VNC password is required to observe this node",
                  details: {
                    code: "DESKTOP_CREDENTIALS_REQUIRED",
                    auth: "vnc-password",
                  },
                },
              },
              {
                transport: "rfb",
                wsPath: "/desktop/observe?token=node",
                expiresAtMs: 60_000,
                control: false,
                auth: "vnc-password",
                preauthenticated: true,
              },
            ],
          },
        },
      });
      const panel = await openDesktopPanel(page);
      await gateway.waitForRequest("environments.list");
      await panel.getByText("node:paired-node", { exact: true }).waitFor();
      expect(await panel.getByText("node:plain-node", { exact: true }).count()).toBe(0);
      await installDesktopClientFake(panel);

      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await panel.getByLabel("VNC password", { exact: true }).fill("node-password");
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await expect.poll(async () => await panel.getAttribute("data-connect-count")).toBe("1");
      expect(await panel.getAttribute("data-used-credentials")).toBe("false");
      const observeRequests = await gateway.getRequests("desktop.observe");
      expect(observeRequests.at(-1)?.params).toEqual({
        source: { kind: "node", nodeId: "paired-node" },
        control: false,
        credentials: { password: "node-password" },
      });
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

      const takeControl = panel.getByRole("button", { name: "Take control", exact: true });
      const overlayCoversStage = await panel.evaluate((element) => {
        const stage = element.shadowRoot?.querySelector<HTMLElement>(".desktop-stage");
        const overlay = element.shadowRoot?.querySelector<HTMLElement>(
          ".desktop-stage__take-control",
        );
        if (!stage || !overlay) {
          return false;
        }
        const stageRect = stage.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        return (
          Math.abs(stageRect.width - overlayRect.width) < 1 &&
          Math.abs(stageRect.height - overlayRect.height) < 1
        );
      });
      expect(overlayCoversStage).toBe(true);
      await takeControl.click();
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

  it("takes control by clicking a real noVNC-mounted desktop", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("active"),
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
      await page.goto(`${suite.server.baseUrl}chat`);
      // Route desktop observe sockets to an in-page RFB 3.8 server (security
      // None) so the production DesktopClient drives the real noVNC client.
      await page.evaluate(() => {
        const GatewaySocket = window.WebSocket;
        class FakeRfbSocket extends EventTarget {
          binaryType = "arraybuffer";
          protocol = "";
          readyState = 0;
          onerror: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
          onopen: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          private handshake = 0;
          constructor() {
            super();
            setTimeout(() => {
              if (this.readyState !== 0) {
                return;
              }
              this.readyState = 1;
              this.onopen?.(new Event("open"));
              this.deliver(new TextEncoder().encode("RFB 003.008\n"));
            }, 0);
          }
          private deliver(bytes: Uint8Array<ArrayBuffer>): void {
            setTimeout(() => {
              if (this.readyState === 1) {
                this.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
              }
            }, 0);
          }
          send(): void {
            // Handshake replies are fixed-size, so respond by stage instead of
            // parsing: version -> security types, choice -> ok, init -> ServerInit.
            this.handshake += 1;
            if (this.handshake === 1) {
              this.deliver(new Uint8Array([1, 1]));
            } else if (this.handshake === 2) {
              this.deliver(new Uint8Array([0, 0, 0, 0]));
            } else if (this.handshake === 3) {
              const name = new TextEncoder().encode("fake-desktop");
              const init = new Uint8Array(24 + name.length);
              const view = new DataView(init.buffer);
              view.setUint16(0, 800);
              view.setUint16(2, 600);
              init.set([32, 24, 0, 1], 4);
              view.setUint16(8, 255);
              view.setUint16(10, 255);
              view.setUint16(12, 255);
              init.set([16, 8, 0], 14);
              view.setUint32(20, name.length);
              init.set(name, 24);
              this.deliver(init);
            }
          }
          close(code = 1000, reason = ""): void {
            if (this.readyState === 3) {
              return;
            }
            this.readyState = 3;
            const event = new CloseEvent("close", { code, reason });
            this.onclose?.(event);
            this.dispatchEvent(new CloseEvent("close", { code, reason }));
          }
        }
        const RoutedSocket = function (url: string, protocols?: string | string[]) {
          return url.includes("/desktop/observe")
            ? new FakeRfbSocket()
            : new GatewaySocket(url, protocols);
        };
        RoutedSocket.prototype = GatewaySocket.prototype;
        Object.assign(RoutedSocket, {
          CONNECTING: 0,
          OPEN: 1,
          CLOSING: 2,
          CLOSED: 3,
        });
        window.WebSocket = RoutedSocket as unknown as typeof WebSocket;
      });

      await openDirectDesktop(page, "worker-desktop-1");
      const panel = page.locator("openclaw-desktop-panel");
      await panel.locator("section[aria-label='Desktop']").waitFor();
      await panel.locator(".desktop-surface canvas").waitFor();

      const takeControl = panel.getByRole("button", { name: "Take control", exact: true });
      await takeControl.waitFor();
      // Playwright refuses the click if the noVNC canvas intercepted it, so a
      // successful click proves the overlay hit-tests above the real surface.
      await takeControl.click();
      await expect.poll(async () => (await gateway.getRequests("desktop.observe")).length).toBe(2);
      const observeRequests = await gateway.getRequests("desktop.observe");
      expect(observeRequests[1]?.params).toEqual({
        source: { kind: "environment", environmentId: "worker-desktop-1" },
        control: true,
      });
      await panel.locator(".desktop-surface canvas").waitFor();
      expect(await takeControl.count()).toBe(0);
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
