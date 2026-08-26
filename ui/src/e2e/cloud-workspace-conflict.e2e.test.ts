// Control UI browser proof covers the cloud-workspace conflict recovery lifecycle.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const sessionKey = "agent:main:conflict-proof";

const conflict = {
  paths: ["src/local.ts", "ui/src/app.ts"],
  stagedResultRef: "refs/openclaw/worker-results/claim-proof",
  totalCount: 2,
};

function sessionsList(includeConflict: boolean) {
  const now = Date.now();
  const label = includeConflict ? "Cloud conflict proof" : "Cloud conflict cleared";
  return {
    count: 1,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions: [
      {
        contextTokens: null,
        displayName: label,
        hasActiveRun: false,
        key: sessionKey,
        kind: "direct",
        label,
        model: "gpt-5.5",
        modelProvider: "openai",
        placement: {
          state: "reclaimed",
          generation: 1,
          createdAtMs: now - 10_000,
          updatedAtMs: now,
          stateChangedAtMs: now - 1_000,
          ...(includeConflict ? { workspaceResultConflict: conflict } : {}),
        },
        status: "done",
        totalTokens: 0,
        updatedAt: now,
      },
    ],
    ts: now,
  };
}

function workerRecoverySessionsList(includeError: boolean) {
  const now = Date.now();
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        contextTokens: null,
        displayName: "Cloud worker failure proof",
        hasActiveRun: false,
        key: sessionKey,
        kind: "direct",
        label: "Cloud worker failure proof",
        model: "gpt-5.5",
        modelProvider: "openai",
        placement: {
          state: includeError ? "failed" : "active",
          generation: 2,
          createdAtMs: now - 10_000,
          updatedAtMs: now,
          stateChangedAtMs: now - 1_000,
          environmentId: "worker:lost-proof",
          activeOwnerEpoch: 4,
          workspaceBaseManifestRef: "sha256:workspace-base",
          remoteWorkspaceDir: "/home/crabbox/workspace",
          workerBundleHash: "a".repeat(64),
          ...(includeError
            ? {
                recoveryError: "cloud worker disappeared: provider reported lease destroyed",
                terminalReason: "stale terminal worker failure",
                terminalAtMs: now,
              }
            : {}),
        },
        status: "done",
        totalTokens: 0,
        updatedAt: now,
      },
    ],
    ts: now,
  };
}

async function capture(page: import("playwright").Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI cloud workspace conflict recovery", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows, dismisses, and reloads durable conflict recovery guidance", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "custom",
          customType: "cloud-workspace-conflict",
          content: "Cloud result applied with 2 conflicts.",
          details: conflict,
          timestamp: Date.now() - 500,
        },
      ],
      methodResponses: {
        "sessions.list": sessionsList(true),
      },
      sessionKey,
    });

    try {
      const response = await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      expect(response?.status()).toBe(200);

      const notice = page.locator(".chat-workspace-conflict-notice");
      const sessionRow = page.locator(`[data-session-key="${sessionKey}"]`);
      await notice.waitFor({ timeout: 10_000 });
      await sessionRow.locator('.session-row-badge--cloud[data-workspace-conflicts="2"]').waitFor();
      const historyCard = page.locator(".chat-workspace-conflict-event");
      await historyCard.waitFor();
      expect(await notice.textContent()).toContain("2 cloud workspace conflicts");
      expect(await historyCard.textContent()).toContain(conflict.stagedResultRef);
      await capture(page, "01-live-conflict.png");

      await page.setViewportSize({ width: 390, height: 844 });
      const composer = page.locator(".agent-chat__composer-shell");
      const title = notice.locator(".chat-composer-neighbor-card__copy strong");
      const summary = notice.locator(".chat-composer-neighbor-card__copy > span");
      const dismiss = notice.getByRole("button", { name: "Dismiss workspace conflict notice" });
      await expect
        .poll(async () => {
          const [composerBox, noticeBox] = await Promise.all([
            composer.boundingBox(),
            notice.boundingBox(),
          ]);
          return composerBox && noticeBox ? Math.abs(composerBox.width - noticeBox.width) : null;
        })
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() =>
          title.evaluate((node) => ({
            title: getComputedStyle(node).whiteSpace,
            summary: getComputedStyle(node.nextElementSibling!).whiteSpace,
          })),
        )
        .toEqual({ title: "nowrap", summary: "nowrap" });
      for (const item of [title, summary, dismiss]) {
        const [itemBox, noticeBox] = await Promise.all([item.boundingBox(), notice.boundingBox()]);
        expect(itemBox).not.toBeNull();
        expect(noticeBox).not.toBeNull();
        if (!itemBox || !noticeBox) {
          throw new Error("expected mobile conflict notice layout boxes");
        }
        expect(itemBox.x).toBeGreaterThanOrEqual(noticeBox.x);
        expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(noticeBox.x + noticeBox.width);
        expect(itemBox.y).toBeGreaterThanOrEqual(noticeBox.y);
        expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(noticeBox.y + noticeBox.height);
      }
      await capture(page, "02-mobile-live-conflict.png");

      await dismiss.click();
      await notice.waitFor({ state: "detached" });
      await historyCard.waitFor();
      await capture(page, "03-dismissed-live-notice.png");

      await page.setViewportSize({ width: 1440, height: 900 });
      await gateway.setMethodResponse("sessions.list", sessionsList(false));
      await page.reload();
      await page.locator(".chat-workspace-conflict-event").waitFor({ timeout: 10_000 });
      await sessionRow.getByText("Cloud conflict cleared", { exact: true }).waitFor();
      expect(await page.locator(".chat-workspace-conflict-notice").count()).toBe(0);
      expect(await sessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await page.locator(".chat-workspace-conflict-event").textContent()).toContain(
        conflict.stagedResultRef,
      );
      await capture(page, "04-reloaded-durable-history.png");
    } finally {
      await context.close();
    }
  });

  it("renders historical workspace recovery failures from transcript history", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "custom",
          customType: "cloud-workspace-recovery-failed",
          content:
            "Cloud workspace recovery attempt failed: snapshot verification failed. OpenClaw preserved the result and will retry.",
          timestamp: Date.now() - 500,
        },
      ],
      methodResponses: { "sessions.list": workerRecoverySessionsList(false) },
      sessionKey,
    });

    try {
      const response = await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      expect(response?.status()).toBe(200);
      await page
        .getByText("OpenClaw preserved the result and will retry.", { exact: false })
        .waitFor({
          timeout: 10_000,
        });
      await capture(page, "04-workspace-recovery-failed-history.png");
    } finally {
      await context.close();
    }
  });

  it("shows a durable selected-chat alert while workspace recovery is pending", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Remote work completed successfully." }],
          timestamp: Date.now() - 2_000,
        },
      ],
      methodResponses: { "sessions.list": workerRecoverySessionsList(false) },
      sessionKey,
    });

    try {
      const response = await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      expect(response?.status()).toBe(200);
      await page.getByText("Remote work completed successfully.").waitFor({ timeout: 10_000 });
      expect(await page.getByRole("alert").count()).toBe(0);
      await capture(page, "05-before-workspace-recovery-error.png");

      await gateway.setMethodResponse("sessions.list", workerRecoverySessionsList(true));
      await page.reload();
      const alert = page.getByRole("alert").filter({ hasText: "Runner failed" });
      await alert.waitFor({ timeout: 10_000 });
      expect(await alert.textContent()).toContain("provider reported lease destroyed");
      expect(await alert.textContent()).not.toContain("stale terminal worker failure");
      await capture(page, "05-after-workspace-recovery-error.png");
    } finally {
      await context.close();
    }
  });
});
