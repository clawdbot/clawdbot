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
const updatedAt = "2026-08-29T12:00:00.000Z";
const revisionHash = "a".repeat(64);

function pendingProposal() {
  return {
    createdAt: updatedAt,
    description: "Clean inbox triage",
    id: "proposal-1",
    kind: "create",
    scanState: "clean",
    skillKey: "inbox-cleaner",
    skillName: "Inbox Cleaner",
    status: "pending",
    title: "Inbox Cleaner",
    updatedAt,
  };
}

function pendingManifest() {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt,
    proposals: [pendingProposal()],
  };
}

function pendingInspect() {
  return {
    content: "Review unread mail and archive low-priority threads.",
    record: {
      ...pendingProposal(),
      proposedVersion: "v1",
      target: { skillKey: "inbox-cleaner", skillName: "Inbox Cleaner" },
    },
    revisionHash,
    supportFiles: [],
  };
}

describeControlUiE2e("Skill Workshop proposal confirmation mocked Gateway E2E", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("does not report success when refresh leaves an applied proposal pending", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "skills.proposals.apply",
        "skills.proposals.inspect",
        "skills.proposals.list",
      ],
      methodResponses: {
        "skills.proposals.apply": { ok: true },
        "skills.proposals.inspect": pendingInspect(),
        "skills.proposals.list": pendingManifest(),
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills/workshop`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.proposals.list");
      await page.locator("#skill-workshop-mode-tab-board").click();
      const applyButton = page.locator(".sw-action-bar .sw-btn--primary");
      await applyButton.waitFor();
      await applyButton.click();
      await gateway.waitForRequest("skills.proposals.apply");

      await expect
        .poll(async () => page.locator(".sw-error").textContent())
        .toContain("did not confirm");
      expect(await page.locator(".sw-action-toast").count()).toBe(0);
      expect(await page.locator(".sw-action-bar .sw-btn--primary").count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
