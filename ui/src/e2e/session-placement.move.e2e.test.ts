import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { beforeAll, expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "session-placement-move");
const runnerOfflineProofName = process.env.OPENCLAW_RUNNER_OFFLINE_SCREENSHOT;
const runnerOfflineProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "runner-offline",
);

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({ path: path.join(proofDir, name) });
  }
}

async function captureRunnerOffline(page: Page): Promise<void> {
  if (runnerOfflineProofName) {
    await mkdir(runnerOfflineProofDir, { recursive: true });
    await page.screenshot({ path: path.join(runnerOfflineProofDir, runnerOfflineProofName) });
  }
}

function contextOptions() {
  return {
    locale: "en-US",
    serviceWorkers: "block" as const,
    viewport: { height: 900, width: 1280 },
    ...(captureProof ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } } : {}),
  };
}

function activeSession(placementMove?: {
  target: { kind: "gateway" };
  updatedAtMs: number;
  error?: string;
}) {
  return {
    key: "agent:main:placement-move",
    kind: "direct" as const,
    label: "Move proof",
    updatedAt: 2,
    hasActiveRun: true,
    placement: {
      state: "active" as const,
      generation: 4,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
      environmentId: "worker:source",
      activeOwnerEpoch: 7,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/workspace/move-proof",
    },
    ...(placementMove ? { placementMove } : {}),
  };
}

suite.define(() => {
  beforeAll(async () => {
    if (captureProof) {
      await mkdir(proofDir, { recursive: true });
    }
  });

  it("shows authoritative device targets to writers and moves through the exact-source RPC", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "environments.list", "sessions.move"],
      operatorScopes: ["operator.read", "operator.write"],
      historyMessages: [{ role: "assistant", content: "Placement move proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([activeSession()]),
        "environments.list": {
          profiles: [{ id: "aws", providerId: "crabbox", trust: "disposable" }],
          environments: [
            {
              id: "node:writer-runner",
              type: "node",
              label: "Writer runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
            {
              id: "node:saturated",
              type: "node",
              label: "Busy runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 0 },
            },
            {
              id: "node:offline",
              type: "node",
              label: "Offline runner",
              status: "unavailable",
              sessionHost: true,
            },
            {
              id: "node:nonhost",
              type: "node",
              label: "Hosting disabled",
              status: "available",
              sessionHost: false,
            },
          ],
        },
      },
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("sessions.move");
      await page.getByRole("button", { name: "Runs on Cloud" }).click();
      await page.getByText("Move session…", { exact: true }).click();
      await page.getByText("The active turn will be interrupted.", { exact: false }).waitFor();
      await page.locator('[data-value="gateway"]').waitFor();
      await page.locator('[data-value="device:writer-runner"]').waitFor();
      expect(await page.locator('[data-value="cloud:aws"]').count()).toBe(0);
      expect(await page.locator('[data-value="device:saturated"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-value="device:offline"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-value="device:nonhost"]').isDisabled()).toBe(true);
      await page.getByText("No worker slots are available", { exact: false }).waitFor();
      await page.getByText("Device unavailable", { exact: false }).waitFor();
      await page.getByText("Session hosting is disabled", { exact: false }).waitFor();
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      await page.locator('[data-value="device:writer-runner"]').click();
      await capture(page, "01-destination-picker-with-warning.png");
      await page.getByRole("button", { name: "Move session", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.move");
      expect(request.params).toEqual({
        key: "agent:main:placement-move",
        agentId: "main",
        expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
        target: { kind: "device", deviceId: "writer-runner" },
      });
      await page.getByRole("button", { name: "Moving session…" }).waitFor();
      await capture(page, "03-moving.png");

      await gateway.resolveDeferred("sessions.move", {
        ok: true,
        key: "agent:main:placement-move",
        sessionId: "session-placement-move",
        placement: { state: "active", generation: 10 },
      });
      await capture(page, "04-moved.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("waits for an offline device or explicitly continues from Gateway-synced state", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    const session = activeSession();
    session.placement = {
      ...session.placement,
      runner: { kind: "device", status: "offline" },
    } as typeof session.placement;
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.move"],
      operatorScopes: ["operator.read", "operator.write"],
      historyMessages: [{ role: "assistant", content: "Offline device recovery proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-pane__placement-chip").waitFor();
      await page.getByRole("button", { name: "Device offline" }).waitFor();
      await page.locator(".chat-pane__placement-chip").click();
      await page
        .getByText("Waiting for device to reconnect; retry after it returns", { exact: false })
        .waitFor();
      session.placement = {
        ...session.placement,
        runner: { kind: "device", status: "available" },
      } as typeof session.placement;
      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([session]));
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await page.getByRole("button", { name: "Runs on device" }).waitFor();
      expect(await page.locator(".chat-pane__placement-note").count()).toBe(0);

      session.placement = {
        ...session.placement,
        runner: { kind: "device", status: "offline" },
      } as typeof session.placement;
      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([session]));
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await page.getByRole("button", { name: "Device offline" }).waitFor();
      const continueAction = page.getByText("Continue on Gateway…", { exact: true });
      if (!(await continueAction.isVisible())) {
        await page.getByRole("button", { name: "Device offline" }).click();
      }
      const moveItem = page.locator(".chat-pane__placement-move");
      const reclaimItem = page.locator(".chat-pane__placement-reclaim");
      expect(await moveItem.isDisabled()).toBe(false);
      expect(await reclaimItem.isDisabled()).toBe(true);
      expect(await reclaimItem.getAttribute("title")).toContain("Reconnect the device");
      await captureRunnerOffline(page);
      await continueAction.click();
      await page.getByText("Unsynced device files", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Continue on Gateway", exact: true }).click();

      const request = await gateway.waitForRequest("sessions.move");
      expect(request.params).toEqual({
        key: "agent:main:placement-move",
        agentId: "main",
        expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
        target: { kind: "gateway" },
        abandonSource: true,
      });
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    { machineId: "fast", expectedMachineClass: "fast" },
    { machineId: "standard", expectedMachineClass: undefined },
  ])(
    "moves to a cloud profile with machine $machineId",
    async ({ machineId, expectedMachineClass }) => {
      const context = await suite.newBrowserContext(contextOptions());
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.startup", "environments.list", "sessions.move"],
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        historyMessages: [{ role: "assistant", content: "Placement machine proof." }],
        methodResponses: {
          "sessions.list": chatSessionListResponse([activeSession()]),
          "environments.list": {
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                trust: "disposable",
                machines: [
                  { id: "standard", label: "Standard", default: true },
                  { id: "fast", label: "Fast" },
                ],
              },
            ],
            environments: [],
          },
        },
        sessionKey: "agent:main:placement-move",
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.deferNext("sessions.move");
        await page.getByRole("button", { name: "Runs on Cloud" }).click();
        await page.getByText("Move session…", { exact: true }).click();
        await page.locator('[data-value="cloud:aws"]').click();
        await page.locator(`[data-value="machine:${machineId}"]`).click();
        await page.getByRole("button", { name: "Move session", exact: true }).click();

        const request = await gateway.waitForRequest("sessions.move");
        expect(request.params).toEqual({
          key: "agent:main:placement-move",
          agentId: "main",
          expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
          target: {
            kind: "profile",
            profileId: "aws",
            ...(expectedMachineClass ? { machineClass: expectedMachineClass } : {}),
          },
        });
        await gateway.resolveDeferred("sessions.move", {
          ok: true,
          key: "agent:main:placement-move",
          sessionId: "session-placement-move",
          placement: { state: "active", generation: 10 },
        });
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps a move failure visible and retryable", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.startup", "environments.list", "sessions.move"],
      historyMessages: [{ role: "assistant", content: "Placement failure proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          activeSession({
            target: { kind: "gateway" },
            updatedAtMs: 3,
            error: "Destination device is offline.",
          }),
        ]),
      },
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Move failed" }).click();
      await page.getByText("Destination device is offline.", { exact: true }).waitFor();
      await page.getByText("Move session…", { exact: true }).waitFor();
      await capture(page, "05-error.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
