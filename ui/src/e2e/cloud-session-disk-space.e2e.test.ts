import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { SessionPlacementDiskSpace } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:disk-monitor";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifactDir: string;
beforeEach(() => {
  if (captureUiProof) {
    artifactDir = createControlUiE2eArtifactDir("cloud-disk");
  }
});
const viewport = { height: 900, width: 1280 };
const gibibyte = 1024 ** 3;
const mebibyte = 1024 ** 2;
const observedAtMs = Date.parse("2026-08-13T16:00:00.000Z");

const suite = createControlUiE2eSuite({
  name: "Control UI cloud-session disk-space monitoring",
  startServer: startControlUiE2eServer,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function sessionsList(diskSpace: SessionPlacementDiskSpace): SessionsListResult {
  const placementUpdatedAtMs = diskSpace.observedAtMs;
  const session: GatewaySessionRow = {
    displayName: "Disk monitor",
    hasActiveRun: false,
    key: sessionKey,
    kind: "direct",
    label: "Disk monitor",
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: observedAtMs - 60_000,
      updatedAtMs: placementUpdatedAtMs,
      stateChangedAtMs: observedAtMs - 30_000,
      environmentId: "worker:disk-monitor",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "sha256:disk-monitor-base",
      remoteWorkspaceDir: "/workspace/disk-monitor",
      diskSpace,
    },
    status: "done",
    totalTokens: 0,
    updatedAt: placementUpdatedAtMs,
  };
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
    path: "",
    sessions: [session],
    ts: placementUpdatedAtMs,
  };
}

suite.define(() => {
  it("refreshes selected-chat and sidebar disk pressure through canonical session events", async () => {
    if (captureUiProof) {
      await mkdir(path.join(artifactDir, "video"), { recursive: true });
    }
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureUiProof
        ? { recordVideo: { dir: path.join(artifactDir, "video"), size: viewport } }
        : {}),
    });
    const page = await context.newPage();
    const video = page.video();
    const healthy = {
      status: "ok",
      availableBytes: 6 * gibibyte,
      totalBytes: 10 * gibibyte,
      observedAtMs,
    } satisfies SessionPlacementDiskSpace;
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Disk monitor is ready." }],
          timestamp: observedAtMs - 1_000,
        },
      ],
      methodResponses: { "sessions.list": sessionsList(healthy) },
      sessionKey,
    });

    const capture = async (name: string): Promise<void> => {
      if (!captureUiProof) {
        return;
      }
      await writeFile(
        path.join(artifactDir, name),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [cloudBadge]),
      );
    };
    const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
    const cloudBadge = sidebarRow.locator(".session-row-badge--cloud");
    const expectAccessibleBadge = async (
      status: SessionPlacementDiskSpace["status"],
      label: string,
    ): Promise<void> => {
      await expect.poll(() => cloudBadge.getAttribute("data-disk-space-status")).toBe(status);
      await expect.poll(() => cloudBadge.getAttribute("aria-label")).toBe(label);
      const descriptionId = await cloudBadge.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      await expect.poll(() => page.locator(`#${descriptionId}`).textContent()).toBe(label);
    };
    const refresh = async (diskSpace: SessionPlacementDiskSpace): Promise<void> => {
      const requestCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.setSessionsListResponse(sessionsList(diskSpace));
      await gateway.emitGatewayEvent("sessions.changed", {
        reason: "worker-disk-space",
        sessionKey,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(requestCount);
    };

    try {
      const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("connect");
      await gateway.waitForRequest("sessions.list");
      await page.getByText("Disk monitor is ready.", { exact: true }).waitFor();
      await sidebarRow.getByText("Disk monitor", { exact: true }).waitFor();
      expect(await page.locator(".chat-cloud-disk-space-notice").count()).toBe(0);
      await expectAccessibleBadge("ok", "Placement: active");
      await capture("01-healthy.png");

      await refresh({
        status: "warning",
        availableBytes: 247 * mebibyte,
        totalBytes: 6 * gibibyte,
        observedAtMs: observedAtMs + 1_000,
      });
      const warning = page
        .getByRole("status")
        .filter({ hasText: "Cloud session disk space is low" });
      await warning.waitFor();
      expect(await warning.textContent()).toContain(
        "96% used · 247 MB free. Delete unneeded files or stop the cloud worker before large writes.",
      );
      await expectAccessibleBadge("warning", "Placement: active · Cloud session disk space is low");
      await capture("02-warning.png");

      await refresh({
        status: "critical",
        availableBytes: 80 * mebibyte,
        totalBytes: 6 * gibibyte,
        observedAtMs: observedAtMs + 2_000,
      });
      const critical = page
        .getByRole("alert")
        .filter({ hasText: "Cloud session disk space is critically low" });
      await critical.waitFor();
      expect(await critical.textContent()).toContain(
        "99% used · 80 MB free. New writes may fail and stop the agent. Delete unneeded files or stop the cloud worker before large writes.",
      );
      await expectAccessibleBadge(
        "critical",
        "Placement: active · Cloud session disk space is critically low",
      );
      await capture("03-critical.png");

      await refresh({ ...healthy, observedAtMs: observedAtMs + 3_000 });
      await expect.poll(() => page.locator(".chat-cloud-disk-space-notice").count()).toBe(0);
      await expectAccessibleBadge("ok", "Placement: active");
      await capture("04-recovered.png");
    } finally {
      await suite.closeBrowserContext(context);
      if (video) {
        await video.saveAs(path.join(artifactDir, "cloud-session-disk-space.webm"));
      }
    }
  });
});
