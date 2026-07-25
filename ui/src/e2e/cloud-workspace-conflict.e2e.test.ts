// Control UI browser proof covers the cloud-workspace conflict recovery lifecycle.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
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
      const response = await page.goto(
        `${server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`,
      );
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

      await page.getByRole("button", { name: "Dismiss workspace conflict notice" }).click();
      await notice.waitFor({ state: "detached" });
      await historyCard.waitFor();
      await capture(page, "02-dismissed-live-notice.png");

      await gateway.setMethodResponse("sessions.list", sessionsList(false));
      await page.reload();
      await page.locator(".chat-workspace-conflict-event").waitFor({ timeout: 10_000 });
      await sessionRow.getByText("Cloud conflict cleared", { exact: true }).waitFor();
      expect(await page.locator(".chat-workspace-conflict-notice").count()).toBe(0);
      expect(await sessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await page.locator(".chat-workspace-conflict-event").textContent()).toContain(
        conflict.stagedResultRef,
      );
      await capture(page, "03-reloaded-durable-history.png");
    } finally {
      await context.close();
    }
  });
});
