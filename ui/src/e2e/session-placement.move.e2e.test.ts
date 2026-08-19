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

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({ path: path.join(proofDir, name) });
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

function localSession() {
  return {
    key: "agent:main:placement-move",
    kind: "direct" as const,
    label: "Move proof",
    updatedAt: 3,
    hasActiveRun: false,
    placement: {
      state: "local" as const,
      generation: 10,
      createdAtMs: 1,
      updatedAtMs: 3,
      stateChangedAtMs: 3,
    },
  };
}

suite.define(() => {
  beforeAll(async () => {
    if (captureProof) {
      await mkdir(proofDir, { recursive: true });
    }
  });

  it("moves the selected session through the exact-source RPC", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "environments.list", "node.list", "sessions.move"],
      historyMessages: [{ role: "assistant", content: "Placement move proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([activeSession()]),
        "environments.list": {
          profiles: [{ id: "aws", providerId: "crabbox", trust: "disposable" }],
          environments: [],
        },
        "node.list": { nodes: [] },
      },
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("sessions.move");
      await page.getByRole("button", { name: "Runs on Cloud" }).click();
      await page.getByText("Move session…", { exact: true }).click();
      await page.getByText("The active turn will be interrupted.", { exact: false }).waitFor();
      await capture(page, "01-destination-picker-with-warning.png");
      await page.getByRole("button", { name: "Move session", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.move");
      expect(request.params).toEqual({
        key: "agent:main:placement-move",
        agentId: "main",
        expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
        target: { kind: "gateway" },
      });
      await page.getByRole("button", { name: "Moving session…" }).waitFor();
      await capture(page, "03-moving.png");

      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([localSession()]));
      await gateway.resolveDeferred("sessions.move", {
        ok: true,
        key: "agent:main:placement-move",
        sessionId: "session-placement-move",
        placement: { state: "local", generation: 10 },
      });
      await page.getByRole("button", { name: "Runs on Cloud" }).waitFor({ state: "detached" });
      await capture(page, "04-moved.png");
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
        featureMethods: ["chat.startup", "environments.list", "node.list", "sessions.move"],
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
          "node.list": { nodes: [] },
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
      featureMethods: ["chat.startup", "environments.list", "node.list", "sessions.move"],
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
