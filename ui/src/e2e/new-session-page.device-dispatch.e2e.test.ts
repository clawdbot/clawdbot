import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureDeviceRuntimeUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const deviceTargets = [
  { name: "selected", value: "device:paired-runner", target: { deviceId: "paired-runner" } },
  { name: "automatic", value: "auto-device", target: { autoDevice: true } },
];

suite.define(() => {
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
        "sessions.list": createdSessionListResult(sessionKey),
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-device-dispatch",
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
      await captureDeviceRuntimeUiProof(page, "01-main-agent-paired-node-selected.png");

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
      await captureDeviceRuntimeUiProof(page, "02-research-agent-local-destination-restored.png");

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

  it("reloads a pending device create with the same placement target", async () => {
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
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.dispatch": { placement: { state: "active", generation: 1 } },
        "sessions.send": { runId: "run-device-recovery", status: "started" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page.locator('[data-value="device:paired-runner"]').click();
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
        .poll(() => page.locator("#new-session-where-trigger").getAttribute("data-device-id"))
        .toBe("paired-runner");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const retryCreate = await gateway.waitForRequest("sessions.create");
      expect(retryCreate.params).toMatchObject({ key: sessionKey, message: "", worktree: true });
      await gateway.resolveDeferred("sessions.create", { key: sessionKey });
      await expect(gateway.waitForRequest("sessions.dispatch")).resolves.toMatchObject({
        params: { key: sessionKey, agentId: "main", deviceId: "paired-runner" },
      });
      await expect(gateway.waitForRequest("sessions.send")).resolves.toMatchObject({
        params: { key: sessionKey, agentId: "main", message },
      });
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });
});
