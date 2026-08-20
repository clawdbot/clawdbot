import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar attention dismissal E2E",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const artifactDir = path.resolve(".artifacts/control-ui-e2e/sidebar-attention");
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

function failedCron(id: string) {
  return {
    id,
    name: `Failed automation ${id}`,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    state: { lastRunStatus: "error", lastError: `Failure ${id}` },
  };
}

function cronListResponse(id: string) {
  return {
    jobs: [failedCron(id)],
    snapshotRevision: `sidebar-attention-${id}`,
    total: 1,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

suite.define(() => {
  it("offers incident and permanent dismissal choices", async () => {
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      recordVideo: captureProof
        ? { dir: artifactDir, size: { width: 1_280, height: 900 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": cronListResponse("first"),
        "models.authStatus": { ts: 1, providers: [] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const chip = page.locator(".sidebar-attention__item", {
        hasText: "1 automation(s) failed",
      });
      await chip.waitFor({ state: "visible" });
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "01-failed-alert.png") });
      }

      await chip.locator(".sidebar-attention__dismiss").click();
      await expect.poll(() => chip.count()).toBe(1);
      const menu = page.locator("wa-dropdown.sidebar-attention__dismiss-menu");
      await expect.poll(() => menu.getAttribute("open")).not.toBeNull();
      await expect
        .poll(async () =>
          (await menu.locator("wa-dropdown-item").allTextContents()).map((text) => text.trim()),
        )
        .toEqual(["Dismiss", "Dismiss and don't show again"]);
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "02-dismiss-menu.png") });
      }

      await menu.locator('wa-dropdown-item[value="dismiss"]').click();
      await expect.poll(() => chip.count()).toBe(0);

      await gateway.setMethodResponse("cron.list", cronListResponse("second"));
      await gateway.emitGatewayEvent("cron", {});
      await chip.waitFor({ state: "visible" });
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "03-new-incident.png") });
      }

      await chip.locator(".sidebar-attention__dismiss").click();
      await menu.locator('wa-dropdown-item[value="dismiss-permanently"]').click();
      await expect.poll(() => chip.count()).toBe(0);
      expect(
        await page.evaluate(() => {
          const key = Object.keys(localStorage).find((candidate) =>
            candidate.startsWith("openclaw.control.sidebarAttention.v1:"),
          );
          return key ? JSON.parse(localStorage.getItem(key) ?? "null").cronFailed : null;
        }),
      ).toBe(true);

      await gateway.setMethodResponse("cron.list", cronListResponse("third"));
      const requestCount = (await gateway.getRequests("cron.list")).length;
      await gateway.emitGatewayEvent("cron", {});
      await expect
        .poll(async () => (await gateway.getRequests("cron.list")).length)
        .toBeGreaterThan(requestCount);
      await expect.poll(() => chip.count()).toBe(0);

      await page.reload();
      await gateway.waitForRequest("cron.list");
      await page.waitForFunction(() => {
        const element = document.querySelector("openclaw-sidebar-attention") as HTMLElement & {
          cronJobs?: Array<{ id?: string }>;
        };
        return element?.cronJobs?.some((job) => job.id === "third") === true;
      });
      await expect.poll(() => chip.count()).toBe(0);
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "04-hidden-after-reload.png") });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
