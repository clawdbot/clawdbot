import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { CLOUD_PROFILE_RETRY_DELAYS_MS } from "../pages/new-session/cloud-profile-discovery.ts";
import {
  WORKSPACE,
  captureDeviceRuntimeUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const deviceTargets = [
  { name: "selected", value: "device:paired-runner", target: { deviceId: "paired-runner" } },
  { name: "automatic", value: "auto-device", target: { autoDevice: true } },
];
const gitRepository = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};

suite.define(() => {
  it("spaces destination section headings consistently", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.admin", "operator.read", "operator.write"],
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "node:paired-runner",
              type: "node",
              label: "Paired runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 1 },
            },
          ],
          profiles: [{ id: "aws", providerId: "aws" }],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();

      const headings = page.locator(
        ".new-session-page__where-popover .new-session-page__menu-title",
      );
      await expect
        .poll(() => headings.allTextContents())
        .toEqual(["Environments", "Your devices", "Cloud"]);
      const spacing = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--space-2").trim(),
      );
      expect(
        await headings.evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).marginTop),
        ),
      ).toEqual(["0px", spacing, spacing]);
    } finally {
      await context.close();
    }
  });

  it.each(deviceTargets)("dispatches the $name device", async ({ value, target }) => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const sessionKey = "agent:main:device-dispatch";
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "gateway",
              type: "local",
              label: "Gateway local",
              status: "available",
              sessionHost: true,
            },
            {
              id: "node:paired-runner",
              type: "node",
              label: "Paired runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 1 },
            },
          ],
          profiles: [],
        },
        "sessions.create": { key: sessionKey },
        "worktrees.branches": gitRepository,
        "sessions.list": createdSessionListResult(sessionKey),
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: `session:${sessionKey}`,
          placement: { state: "active", generation: 1 },
        },
        "sessions.describe": {
          session: { placement: { state: "requested", generation: 1 } },
        },
        "sessions.send": { runId: "run-device-dispatch", status: "started" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page.locator(`[data-value="${value}"]`).click();
      await page.locator(".new-session-page__message").fill("run on the paired device");
      expect(await page.locator('wa-dropdown-item[value="start-terminal"]').count()).toBe(0);
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "",
        worktree: true,
      });
      expect(create.params).not.toHaveProperty("execNode");
      expect(await gateway.getRequests("node.list")).toHaveLength(0);

      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({
        key: sessionKey,
        agentId: "main",
        ...target,
      });
      const send = await gateway.waitForRequest("sessions.send");
      expect(send.params).toMatchObject({
        key: sessionKey,
        message: "run on the paired device",
      });
      const requests = await gateway.getRequests();
      expect(requests.findIndex((request) => request.id === create.id)).toBeLessThan(
        requests.findIndex((request) => request.id === dispatch.id),
      );
      expect(requests.findIndex((request) => request.id === dispatch.id)).toBeLessThan(
        requests.findIndex((request) => request.id === send.id),
      );
    } finally {
      await context.close();
    }
  });

  it.each(deviceTargets)(
    "does not dispatch the $name device from stale capacity during a failed topology refresh",
    async ({ value }) => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        ...(process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? { recordVideo: { dir: path.join(suite.artifactDir, "device-runtime-gating") } }
          : {}),
      });
      const page = await context.newPage();
      const environment = {
        id: "node:paired-runner",
        type: "node",
        label: "Paired runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 2, available: 1 },
      };
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": { environments: [environment], profiles: [] },
          "sessions.create": { key: "agent:main:stale-device-capacity" },
          "worktrees.branches": gitRepository,
        },
      });

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        const where = page.locator("#new-session-where-trigger");
        await where.click();
        await page.locator(`[data-value="${value}"]`).click();
        await page.locator(".new-session-page__message").fill("require current worker capacity");
        const start = page.getByRole("button", { name: "Start session" });
        await expect.poll(() => start.isEnabled()).toBe(true);
        await where.click();
        const selectedDevice = page.locator('[data-value="device:paired-runner"]');
        const automaticDevice = page.locator('[data-value="auto-device"]');
        const localDevice = page.locator('[data-value="gateway"]');
        await selectedDevice.waitFor({ state: "visible" });

        const clockTime = Date.now();
        await page.clock.install({ time: clockTime });
        await page.clock.pauseAt(clockTime + 1_000);
        await gateway.deferNext("environments.list");
        const requestsBeforeRefresh = (await gateway.getRequests("environments.list")).length;
        await gateway.emitGatewayEvent("node.runnerInventory.changed", {
          nodeId: "paired-runner",
        });
        await gateway.waitForRequest("environments.list", { after: requestsBeforeRefresh });
        await expect.poll(() => start.isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        await expect
          .poll(() =>
            where.getAttribute(value === "auto-device" ? "data-auto-device" : "data-device-id"),
          )
          .toBe(value === "auto-device" ? "true" : "paired-runner");

        await gateway.rejectDeferred("environments.list", {
          code: "UNAVAILABLE",
          message: "worker inventory is temporarily unavailable",
        });
        await page.clock.runFor(CLOUD_PROFILE_RETRY_DELAYS_MS[0] - 1);
        expect(await gateway.getRequests("environments.list")).toHaveLength(
          requestsBeforeRefresh + 1,
        );
        await captureDeviceRuntimeUiProof(
          suite,
          page,
          `failed-topology-${value.replace(":", "-")}.png`,
          {
            surface: page.locator('.new-session-page__where-popover wa-popup [part="popup"]'),
            content: [selectedDevice, automaticDevice],
          },
        );
        expect(await start.isDisabled()).toBe(true);
        expect(await selectedDevice.isDisabled()).toBe(true);
        expect(await automaticDevice.isDisabled()).toBe(true);
        expect(await localDevice.isEnabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        await gateway.deferNext("environments.list");
        await page.clock.runFor(1);
        await gateway.waitForRequest("environments.list", { after: requestsBeforeRefresh + 1 });
        await gateway.resolveDeferred("environments.list", {
          environments: [{ ...environment, workerSlots: { total: 2, available: 0 } }],
          profiles: [],
        });
        await expect.poll(() => start.isDisabled()).toBe(true);
        await expect
          .poll(() => start.locator("xpath=..").getAttribute("content"))
          .toContain("No worker slots are available");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        await page.clock.resume();
        await gateway.emitGatewayEvent("node.runnerInventory.changed", {
          nodeId: "paired-runner",
        });
        await gateway.waitForRequest("environments.list", { after: requestsBeforeRefresh + 2 });
        await expect.poll(() => start.isEnabled()).toBe(true);
        expect(await selectedDevice.isEnabled()).toBe(true);
        expect(await automaticDevice.isEnabled()).toBe(true);
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    {
      name: "paired device",
      preference: { kind: "device", id: "paired-runner" },
      attribute: "data-device-id",
      value: "paired-runner",
      target: { deviceId: "paired-runner" },
    },
    {
      name: "automatic device",
      preference: { kind: "auto-device" },
      attribute: "data-auto-device",
      value: "true",
      target: { autoDevice: true },
    },
    {
      name: "cloud worker",
      preference: { kind: "cloud", id: "aws" },
      attribute: "data-cloud-profile",
      value: "aws",
      target: { profileId: "aws" },
    },
  ])(
    "does not start locally while a remembered $name destination is being restored",
    async ({ preference, attribute, value, target }) => {
      const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      if (preference.kind === "cloud") {
        // Browser recovery hydration must not restart the authenticated catalog
        // request or let a remembered remote destination fall back to Local.
        await page.addInitScript(() => {
          const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
          const delayed = new Promise<void>((resolve) => {
            window.addEventListener("test-release-recovery-scope", () => resolve(), { once: true });
          });
          crypto.subtle.digest = async (algorithm, data) => {
            if (new TextDecoder().decode(data) === "e2e-device-token") {
              await delayed;
            }
            return originalDigest(algorithm, data);
          };
        });
      }
      const appUrl = new URL(suite.server.baseUrl);
      const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
      const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
      const sessionKey = "agent:main:restored-remote-destination";
      const catalog = {
        environments: [
          {
            id: "node:paired-runner",
            type: "node",
            label: "Paired runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
        profiles: [{ id: "aws", providerId: "crabbox" }],
      };
      await page.addInitScript(
        ({ key, workspace, where }) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              agents: { main: { workspace, folder: workspace, where, worktree: true } },
            }),
          );
        },
        { key: storageKey, workspace: WORKSPACE, where: preference },
      );
      const gateway = await installMockGateway(page, {
        heldMethods: ["environments.list"],
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": catalog,
          "worktrees.branches": gitRepository,
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
          "sessions.dispatch": { placement: { state: "active", generation: 1 } },
          "sessions.send": { runId: "run-restored-remote", status: "started" },
        },
      });

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await expect
          .poll(() => page.locator("#new-session-checkout-trigger").getAttribute("data-worktree"))
          .toBe("true");
        if (preference.kind === "cloud") {
          await page.evaluate(() => {
            window.dispatchEvent(new Event("test-release-recovery-scope"));
          });
          await waitForGatewayRecoveryScope(page);
          expect(await gateway.getRequests("environments.list")).toHaveLength(1);
        }
        await page.locator(".new-session-page__message").fill("keep my chosen remote destination");
        const start = page.getByRole("button", { name: "Start session" });
        await expect.poll(() => start.isDisabled()).toBe(true);
        await expect
          .poll(() => start.locator("xpath=..").getAttribute("content"))
          .toContain("Restoring your last session setup");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        await gateway.resolveDeferred("environments.list");
        const where = page.locator("#new-session-where-trigger");
        await expect.poll(() => where.getAttribute(attribute)).toBe(value);
        await expect.poll(() => start.isEnabled()).toBe(true);
        await start.click();
        await expect(gateway.waitForRequest("sessions.dispatch")).resolves.toMatchObject({
          params: { key: sessionKey, agentId: "main", ...target },
        });
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    {
      name: "offline paired device",
      preference: { kind: "device", id: "paired-runner" },
      status: "unavailable",
      availableSlots: 1,
      attribute: "data-device-id",
      value: "paired-runner",
      reason: "Device unavailable",
    },
    {
      name: "automatic device without worker capacity",
      preference: { kind: "auto-device" },
      status: "available",
      availableSlots: 0,
      attribute: "data-auto-device",
      value: "true",
      reason: "No worker slots are available",
    },
  ])(
    "keeps a remembered $name blocked until Local is explicitly selected",
    async ({ preference, status, availableSlots, attribute, value, reason }) => {
      const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const appUrl = new URL(suite.server.baseUrl);
      const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
      const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
      const sessionKey = "agent:main:explicit-local-choice";
      await page.addInitScript(
        ({ key, workspace, where }) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              agents: { main: { workspace, folder: workspace, where, worktree: true } },
            }),
          );
        },
        { key: storageKey, workspace: WORKSPACE, where: preference },
      );
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "node:paired-runner",
                type: "node",
                label: "Paired runner",
                status,
                sessionHost: true,
                workerSlots: { total: 2, available: availableSlots },
              },
            ],
            profiles: [],
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        const where = page.locator("#new-session-where-trigger");
        await expect.poll(() => where.getAttribute(attribute)).toBe(value);

        await page.locator(".new-session-page__message").fill("run only where I choose");
        const start = page.getByRole("button", { name: "Start session" });
        await expect.poll(() => start.isDisabled()).toBe(true);
        await expect
          .poll(() => start.locator("xpath=..").getAttribute("content"))
          .toContain(reason);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        await where.click();
        await page.locator('[data-value="gateway"]').click();
        await expect.poll(() => start.isEnabled()).toBe(true);
        await start.click();
        await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
          params: { agentId: "main", message: "run only where I choose" },
        });
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      } finally {
        await context.close();
      }
    },
  );

  it("restores the selected agent's own destination instead of inheriting another agent's device", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const appUrl = new URL(suite.server.baseUrl);
    const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
    const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
    const sessionKey = "agent:research:local-after-agent-switch";
    await page.addInitScript(
      ({ key, workspace }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            agents: {
              research: {
                workspace,
                folder: workspace,
                where: { kind: "local" },
                worktree: false,
              },
            },
          }),
        );
      },
      { key: storageKey, workspace: WORKSPACE },
    );
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", workspace: WORKSPACE, workspaceGit: true },
            { id: "research", workspace: WORKSPACE, workspaceGit: true },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [
            {
              id: "node:paired-runner",
              type: "node",
              label: "Paired runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 1 },
            },
          ],
          profiles: [],
        },
        "sessions.create": { key: sessionKey },
        "sessions.list": createdSessionListResult(sessionKey),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const where = page.locator("#new-session-where-trigger");
      await where.click();
      await page.locator('[data-value="device:paired-runner"]').click();
      await expect.poll(() => where.getAttribute("data-device-id")).toBe("paired-runner");
      await captureDeviceRuntimeUiProof(suite, page, "01-main-agent-paired-node-selected.png");

      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("menuitemradio", { name: "research", exact: true }).click();
      await expect
        .poll(() => agentPicker.locator(".agent-select__label").textContent())
        .toBe("research");
      await expect.poll(() => where.getAttribute("data-device-id")).toBeNull();
      await expect
        .poll(() => where.locator(".new-session-page__trigger-label").textContent())
        .toBe("Local");
      await captureDeviceRuntimeUiProof(
        suite,
        page,
        "02-research-agent-local-destination-restored.png",
      );

      const message = "run this agent locally";
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ agentId: "research", message });
      expect(create.params).not.toHaveProperty("worktree");
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it.each(deviceTargets)(
    "reloads a pending $name device create with the same placement target",
    async ({ value, target }) => {
      const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const message = "resume on the paired device";
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.create"],
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "node:paired-runner",
                type: "node",
                label: "Paired runner",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 2, available: 1 },
              },
            ],
            profiles: [],
          },
          "worktrees.branches": gitRepository,
          "sessions.dispatch": { placement: { state: "active", generation: 1 } },
          "sessions.send": { runId: "run-device-recovery", status: "started" },
        },
      });

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await page.locator("#new-session-where-trigger").click();
        await page.locator(`[data-value="${value}"]`).click();
        await page.locator(".new-session-page__message").fill(message);
        await page.getByRole("button", { name: "Start session" }).click();
        const firstCreate = await gateway.waitForRequest("sessions.create");
        const sessionKey = (firstCreate.params as { key?: string }).key;
        if (!sessionKey) {
          throw new Error("expected a recoverable device create key");
        }

        await page.reload();
        await gateway.waitForRequest("environments.list");
        await expect
          .poll(() =>
            page
              .locator("#new-session-where-trigger")
              .getAttribute(value === "auto-device" ? "data-auto-device" : "data-device-id"),
          )
          .toBe(value === "auto-device" ? "true" : "paired-runner");
        await expect
          .poll(() => page.locator(".new-session-page__message").inputValue())
          .toBe(message);
        await page.getByRole("button", { name: "Start session" }).click();
        const retryCreate = await gateway.waitForRequest("sessions.create");
        expect(retryCreate.params).toMatchObject({ key: sessionKey, message: "", worktree: true });
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        await gateway.deferNext("sessions.dispatch");
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await expect(gateway.waitForRequest("sessions.dispatch")).resolves.toMatchObject({
          params: { key: sessionKey, agentId: "main", ...target },
        });
        expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.dispatch");
        await expect(gateway.waitForRequest("sessions.send")).resolves.toMatchObject({
          params: { key: sessionKey, agentId: "main", message },
        });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
          timeout: 30_000,
        });
      } finally {
        await context.close();
      }
    },
  );
});
