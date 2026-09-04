import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  installMockGateway,
  type ControlUiMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import {
  activateChatHeaderPanelAction,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop document mode",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

let artifactDirectory: string;
beforeEach(() => {
  artifactDirectory = createControlUiE2eArtifactDir("mobile-desktop");
});
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
            disableInput(): void;
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
          disableInput() {
            element.dataset.viewOnly = "true";
          },
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
  describedSession?: unknown,
) {
  await page.setViewportSize({ width: 390, height: 844 });
  const gateway = await installMockGateway(page, {
    deferredMethods: ["environments.list"],
    featureMethods: ["desktop.observe", "environments.list", "openclaw.setup.detect"],
    methodResponses: {
      "desktop.observe": desktopObserve,
      ...(describedSession === undefined
        ? {}
        : { "sessions.describe": { session: describedSession } }),
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
  describedSession?: unknown,
) {
  const document = await startDesktopDocument(page, route, desktopObserve, describedSession);
  await document.gateway.resolveDeferred("environments.list", { environments });
  return document;
}

suite.define(() => {
  it.each(["active", "starting", "offline"])(
    "opens the %s chat session desktop and follows an explicit pop-out selection",
    async (initialState) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
        const sessionKey = "agent:main:cloud-desktop";
        const session = {
          key: sessionKey,
          kind: "direct",
          label: "Cloud desktop session",
          updatedAt: 1,
          placement: {
            state: initialState === "offline" ? "active" : initialState,
            environmentId: "worker-cloud",
            ...(initialState === "offline"
              ? { runner: { kind: "device", status: "offline", deviceId: "workstation" } }
              : {}),
          },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          deferredMethods: ["environments.list"],
          featureMethods: ["desktop.observe", "environments.list"],
          methodResponses: {
            "sessions.list": chatSessionListResponse([session]),
            "desktop.observe": {
              transport: "rfb",
              wsPath: "/desktop/observe?token=chat-session",
              expiresAtMs: 60_000,
              control: false,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        if (initialState !== "active") {
          await openChatSidePanelType(page, "Desktop");
        } else {
          await activateChatHeaderPanelAction(page, "Desktop");
        }
        const panel = page.locator("openclaw-desktop-panel");
        await panel.waitFor({ state: "attached" });
        await gateway.waitForRequest("environments.list");
        await installDesktopClientFake(panel);
        const inventory = {
          environments: [
            gatewayEnvironment,
            {
              id: initialState === "offline" ? "node:workstation" : "worker-cloud",
              type: initialState === "offline" ? "node" : "worker",
              status: "available",
              desktop: true,
            },
            { id: "node:maintenance", type: "node", status: "available", desktop: true },
          ],
        };
        await gateway.resolveDeferred(
          "environments.list",
          initialState === "active" ? inventory : { environments: [gatewayEnvironment] },
        );
        await gateway.setMethodResponse("environments.list", inventory);
        if (initialState !== "active") {
          await panel.getByText("Desktop sources", { exact: true }).waitFor();
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
          await gateway.setSessionsListResponse(
            chatSessionListResponse([
              {
                ...session,
                placement: {
                  ...session.placement,
                  state: "active",
                  ...(session.placement.runner
                    ? { runner: { ...session.placement.runner, status: "available" } }
                    : {}),
                },
              },
            ]),
          );
          await gateway.emitGatewayEvent("sessions.changed", { sessionKey });
        }

        const observed = await gateway.waitForRequest("desktop.observe");
        expect(observed.params).toEqual({
          source:
            initialState === "offline"
              ? { kind: "node", nodeId: "workstation" }
              : { kind: "environment", environmentId: "worker-cloud" },
          control: false,
        });
        await panel.locator("[data-test-remote-desktop='true']").waitFor();
        const popout = page.getByRole("link", { name: "Open desktop in new window" });
        expect(await popout.getAttribute("href")).toBe(
          `/focus/desktop/session/${encodeURIComponent(sessionKey)}`,
        );
        await page.screenshot({
          path: path.join(artifactDirectory, `chat-session-${initialState}-connected.png`),
        });

        await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
        await panel
          .locator(".desktop-environment")
          .filter({ hasText: "node:maintenance" })
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        expect((await gateway.waitForRequest("desktop.observe", { after: 1 })).params).toEqual({
          source: { kind: "node", nodeId: "maintenance" },
          control: false,
        });
        await panel.locator("[data-test-remote-desktop='true']").waitFor();
        const controlResponse = {
          transport: "rfb",
          wsPath: "/desktop/observe?token=manual-selection",
          expiresAtMs: 60_000,
          control: true,
        };
        await gateway.setMethodResponse("desktop.observe", controlResponse);
        await panel.getByRole("button", { name: "Take control", exact: true }).click();
        expect((await gateway.waitForRequest("desktop.observe", { after: 2 })).params).toEqual({
          source: { kind: "node", nodeId: "maintenance" },
          control: true,
        });
        await expect.poll(() => panel.getAttribute("data-view-only")).toBe("false");
        await page.screenshot({
          path: path.join(artifactDirectory, `chat-session-${initialState}-manual-selection.png`),
        });
        const focusPath = "/focus/desktop/control/source/node%3Amaintenance";
        await expect.poll(() => popout.getAttribute("href")).toBe(focusPath);

        const selectedDesktop = await panel
          .locator("[data-test-remote-desktop='true']")
          .elementHandle();
        // Placement changes must not even briefly rewrite an explicit pop-out link.
        const hrefChanges = await popout.evaluateHandle((link) => {
          const previousHrefs: Array<string | null> = [];
          const observer = new MutationObserver((changes) => {
            previousHrefs.push(...changes.map((change) => change.oldValue));
          });
          observer.observe(link, {
            attributes: true,
            attributeFilter: ["href"],
            attributeOldValue: true,
          });
          return { observer, previousHrefs };
        });
        await gateway.setSessionsListResponse(
          chatSessionListResponse([
            {
              ...session,
              placement: { state: "active", environmentId: "worker-replacement" },
            },
          ]),
        );
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "placement" });
        await expect
          .poll(() =>
            panel.evaluate(
              (element) => (element as HTMLElement & { requestedSource: string }).requestedSource,
            ),
          )
          .toBe("worker-replacement");
        await page.screenshot({
          path: path.join(artifactDirectory, `chat-session-${initialState}-placement-update.png`),
        });
        expect(await selectedDesktop?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(3);
        expect(await panel.getAttribute("data-view-only")).toBe("false");
        expect(await popout.getAttribute("href")).toBe(focusPath);
        const observedHrefs = await hrefChanges.evaluate(({ observer, previousHrefs }) => {
          previousHrefs.push(...observer.takeRecords().map((change) => change.oldValue));
          observer.disconnect();
          return previousHrefs;
        });
        expect(observedHrefs.filter((href) => href !== focusPath)).toEqual([]);

        const popupScenario = {
          sessionKey,
          deferredMethods: ["environments.list"],
          featureMethods: ["desktop.observe", "environments.list"],
          methodResponses: { "desktop.observe": controlResponse },
        };
        await context.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
          route.fulfill({ json: createControlUiMockBootstrapConfig(popupScenario) }),
        );
        await context.addInitScript({
          content: createControlUiMockGatewayInitScript(popupScenario),
        });
        const [popup] = await Promise.all([context.waitForEvent("page"), popout.click()]);
        try {
          await popup.waitForLoadState("domcontentloaded");
          expect(new URL(popup.url()).pathname).toBe(focusPath);
          const focusedPanel = popup.locator("openclaw-desktop-panel");
          await focusedPanel.waitFor({ state: "attached" });
          await popup.waitForFunction(
            () =>
              (
                window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
              ).openclawControlUiE2eGateway?.findRequests("environments.list").length,
          );
          await installDesktopClientFake(focusedPanel);
          await popup.evaluate((environments) => {
            (
              window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
            ).openclawControlUiE2eGateway?.resolveDeferred("environments.list", environments);
          }, inventory);
          await focusedPanel.locator("[data-test-remote-desktop='true']").waitFor();
          expect(
            await popup.evaluate(() =>
              (
                window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
              ).openclawControlUiE2eGateway
                ?.findRequests("desktop.observe")
                .map((request) => request.params),
            ),
          ).toEqual([{ source: { kind: "node", nodeId: "maintenance" }, control: true }]);
          await expect.poll(() => focusedPanel.getAttribute("data-view-only")).toBe("false");
          await popup.screenshot({
            path: path.join(
              artifactDirectory,
              `chat-session-${initialState}-focused-selection.png`,
            ),
          });
        } finally {
          await popup.close();
        }
      });
    },
  );

  it("returns from an unavailable focused desktop", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator("openclaw-app-shell").waitFor();
      await page.goto(`${suite.server.baseUrl}focus/desktop`);

      await page
        .getByText("Desktop viewing is unavailable for this connection.", { exact: true })
        .waitFor();
      const back = page.getByRole("button", { name: "Back", exact: true });
      await back.waitFor();
      await back.click();
      await page.waitForURL(`${suite.server.baseUrl}dashboards`);
    });
  });

  it("renders a full-bleed shell-free picker", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { panel } = await openDesktopDocument(page, "focus/desktop", [gatewayEnvironment]);
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

      await page.screenshot({
        path: path.join(artifactDirectory, "picker-390x844.png"),
        fullPage: false,
      });
    });
  });

  it("falls back to the picker with a notice for an unobservable source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/source/missing-machine",
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

  it.each([
    {
      name: "execution node",
      session: { execNode: "workstation" },
      environment: { id: "node:workstation", type: "node" },
      source: { kind: "node", nodeId: "workstation" },
    },
    {
      name: "paired device placement",
      session: {
        placement: {
          state: "active",
          environmentId: "worker-device",
          runner: { kind: "device", deviceId: "workstation", status: "available" },
        },
      },
      environment: { id: "node:workstation", type: "node" },
      source: { kind: "node", nodeId: "workstation" },
    },
    {
      name: "cloud placement",
      session: { placement: { state: "active", environmentId: "worker-cloud" } },
      environment: { id: "worker-cloud", type: "worker" },
      source: { kind: "environment", environmentId: "worker-cloud" },
    },
  ])("resolves a $name session to its observable machine and auto-connects", async (scenario) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:mobile-session";
      const { gateway, panel } = await openDesktopDocument(
        page,
        `focus/desktop/session/${encodeURIComponent(sessionKey)}`,
        [
          gatewayEnvironment,
          {
            ...scenario.environment,
            status: "available",
            desktop: true,
          },
        ],
        undefined,
        {
          key: sessionKey,
          kind: "direct",
          updatedAt: 1,
          ...scenario.session,
        },
      );

      const request = await gateway.waitForRequest("desktop.observe");
      expect(request.params).toEqual({
        source: scenario.source,
        control: false,
      });
      await panel.locator("[data-test-remote-desktop='true']").waitFor();
      await gateway.setMethodResponse("sessions.describe", {
        session: {
          key: sessionKey,
          kind: "direct",
          updatedAt: 2,
          ...scenario.session,
          placement: { state: "reclaimed" },
        },
      });
      await gateway.setMethodResponse("environments.list", {
        environments: [gatewayEnvironment, { ...scenario.environment, desktop: true }],
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "reclaim" });
      await panel.getByText("Desktop sources", { exact: true }).waitFor();
      expect(await panel.locator("[data-test-remote-desktop='true']").count()).toBe(0);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);

      await gateway.setMethodResponse("sessions.describe", {
        session: { key: sessionKey, kind: "direct", updatedAt: 3, ...scenario.session },
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "placement" });
      await panel.locator("[data-test-remote-desktop='true']").waitFor();
      expect((await gateway.getRequests("desktop.observe")).at(-1)?.params).toEqual({
        source: scenario.source,
        control: false,
      });
      await page.screenshot({
        path: path.join(
          artifactDirectory,
          `session-${scenario.name.replaceAll(" ", "-")}-390x844.png`,
        ),
        fullPage: false,
      });
    });
  });

  it("uses an explicit source without resolving a session", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway } = await openDesktopDocument(page, "focus/desktop/source/gateway", [
        gatewayEnvironment,
        {
          id: "node:workstation",
          type: "node",
          status: "available",
          desktop: true,
        },
      ]);

      const request = await gateway.waitForRequest("desktop.observe");
      expect(request.params).toEqual({ source: { kind: "host" }, control: false });
      expect(await gateway.getRequests("sessions.describe")).toHaveLength(0);
    });
  });

  it.each([
    { name: "unknown", session: null },
    {
      name: "reclaimed cloud",
      session: {
        key: "agent:main:missing",
        kind: "direct",
        updatedAt: 1,
        placement: { state: "reclaimed", environmentId: "worker-stopped" },
      },
    },
  ])("falls back to the picker with a notice for a $name session", async ({ session }) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/session/agent%3Amain%3Amissing",
        [gatewayEnvironment],
        undefined,
        session,
      );

      await panel
        .getByText("The requested desktop source is unavailable. Choose another source.", {
          exact: true,
        })
        .waitFor();
      await panel.getByText("Desktop sources", { exact: true }).waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      await page.screenshot({
        path: path.join(artifactDirectory, "unknown-session-picker-390x844.png"),
        fullPage: false,
      });
    });
  });

  it("renders inventory failure recovery and retries the preselected source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await startDesktopDocument(page, "focus/desktop/source/gateway");
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

  it("recovers a session-preselected desktop after an inventory failure", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:mobile-session";
      const nodeEnvironment = {
        id: "node:workstation",
        type: "node",
        status: "available",
        desktop: true,
      };
      const { gateway, panel } = await startDesktopDocument(
        page,
        `focus/desktop/session/${encodeURIComponent(sessionKey)}`,
        undefined,
        { key: sessionKey, kind: "direct", updatedAt: 1, execNode: "workstation" },
      );
      await gateway.rejectDeferred("environments.list", {
        code: "UNAVAILABLE",
        message: "desktop inventory is temporarily unavailable",
      });

      // A session key only names a machine once the inventory loads, so recovery here has no
      // preselected environment to reconnect to and must retry the inventory instead.
      const retry = panel.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);

      await gateway.setMethodResponse("environments.list", {
        environments: [gatewayEnvironment, nodeEnvironment],
      });
      await retry.click();
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({
        source: { kind: "node", nodeId: "workstation" },
        control: false,
      });
      await panel.locator("[data-test-remote-desktop='true']").waitFor();
    });
  });

  it("auto-connects view-only and provides four working touch actions", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/source/gateway",
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

      await page.screenshot({
        path: path.join(artifactDirectory, "connected-toolbar-390x844.png"),
        fullPage: false,
      });
    });
  });

  it("applies the optional control segment as the initial control request", async () => {
    for (const [route, expected] of [
      ["focus/desktop/source/gateway", false],
      ["focus/desktop/control/source/gateway", true],
    ] as const) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { gateway } = await openDesktopDocument(page, route, [gatewayEnvironment], {
          transport: "rfb",
          wsPath: `/desktop/observe?token=control-${String(expected)}`,
          expiresAtMs: 60_000,
          control: expected,
        });
        const request = await gateway.waitForRequest("desktop.observe");
        expect(request.params).toEqual({ source: { kind: "host" }, control: expected });
      });
    }
  });
});
