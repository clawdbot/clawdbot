import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Debug diagnostics mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-debug-diagnostics");
  }
});

suite.define(() => {
  it("renders status, health, heartbeat, and model snapshots from the Gateway", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 1000, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            status: {
              runtime: "diagnostics-e2e",
              securityAudit: { summary: { critical: 0, warn: 1, info: 2 } },
            },
            health: { ok: true, gateway: "healthy" },
            "models.list": {
              models: [
                {
                  available: true,
                  id: "gpt-5.6-luna",
                  name: "GPT-5.6 Luna",
                  provider: "openai",
                },
              ],
            },
            "last-heartbeat": { ageMs: 1250, source: "gateway-heartbeat" },
            "diagnostics.lanes": {
              lanes: [
                {
                  lane: "main",
                  queuedCount: 0,
                  activeCount: 0,
                  maxConcurrent: 16,
                  draining: false,
                  generation: 1,
                },
              ],
              dynamic: null,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}debug`);
        expect(response?.status()).toBe(200);
        await page.locator(".page-title", { hasText: "Debug" }).waitFor();
        const snapshots = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Snapshots" }),
        });
        await snapshots.waitFor();
        await expect.poll(() => snapshots.textContent()).toContain("1 warning");
        await expect.poll(() => snapshots.textContent()).toContain("diagnostics-e2e");
        await expect.poll(() => snapshots.textContent()).toContain("healthy");
        await expect.poll(() => snapshots.textContent()).toContain("gateway-heartbeat");
        const models = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Models" }),
        });
        await expect.poll(() => models.textContent()).toContain("gpt-5.6-luna");

        for (const method of [
          "status",
          "health",
          "models.list",
          "last-heartbeat",
          "diagnostics.lanes",
        ]) {
          const requests = await gateway.getRequests(method);
          expect(requests.length).toBeGreaterThanOrEqual(1);
          expect(requests[0]?.params).toEqual(
            method === "models.list" ? { agentId: "main", preparedOnly: true } : {},
          );
        }

        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "diagnostic-snapshots.png"),
          });
          await models.scrollIntoViewIfNeeded();
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "models-snapshot.png"),
          });
        }
      },
    );
  });
});
