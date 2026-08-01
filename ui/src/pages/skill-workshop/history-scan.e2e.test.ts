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
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowser = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "skill-workshop-history-scan",
);

let browser: Browser | null = null;
let server: ControlUiE2eServer | null = null;

const emptyProposals = {
  schema: "openclaw.skill-workshop.proposals-manifest.v1",
  updatedAt: "2026-07-13T08:00:00.000Z",
  proposals: [],
};

const emptyHistory = {
  schema: "openclaw.skill-workshop.history-scan.v1",
  hasScanned: false,
  reviewedSessions: 0,
  ideasFound: 0,
  hasMore: false,
  lastScanReviewed: 0,
  lastScanIdeas: 0,
};

const scannedHistory = {
  ...emptyHistory,
  hasScanned: true,
  reviewedSessions: 34,
  ideasFound: 2,
  hasMore: true,
  lastScanReviewed: 20,
  lastScanIdeas: 2,
  lastScanAt: "2026-07-13T08:00:00.000Z",
  oldestReviewedAt: "2026-06-18T08:00:00.000Z",
  newestReviewedAt: "2026-07-13T08:00:00.000Z",
};

describeBrowser("Skill Workshop history scan browser flow", () => {
  beforeAll(async () => {
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
    server = null;
    await browser?.close();
    browser = null;
  });

  it("progresses from recent ideas to an earlier-work continuation", async () => {
    if (!browser || !server) {
      throw new Error("Expected browser test fixtures");
    }
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    try {
      const gateway = await installMockGateway(page, {
        assistantAgentId: "main",
        assistantName: "Molty",
        defaultAgentId: "main",
        methodResponses: {
          "skills.proposals.list": emptyProposals,
          "skills.proposals.historyStatus": emptyHistory,
          "skills.proposals.historyScan": scannedHistory,
        },
      });
      await page.goto(`${server.baseUrl}skills/workshop`);

      const findIdeas = page.getByRole("button", { name: "Find skill ideas" });
      await expect.poll(() => findIdeas.isVisible()).toBe(true);
      await expect.poll(() => page.getByText("Find reusable workflows").isVisible()).toBe(true);
      if (captureProof) {
        await page.screenshot({ fullPage: true, path: path.join(artifactDir, "01-initial.png") });
      }
      await findIdeas.click();

      await expect.poll(() => page.getByText("34 threads reviewed").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("2 ideas found").isVisible()).toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Scan earlier work" }).isVisible())
        .toBe(true);
      const scanRequests = await gateway.getRequests("skills.proposals.historyScan");
      expect(scanRequests).toHaveLength(1);
      expect(scanRequests[0]?.params).toEqual({ agentId: "main", direction: "older" });
      if (captureProof) {
        await page.screenshot({ fullPage: true, path: path.join(artifactDir, "02-scanned.png") });
      }

      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
    } finally {
      await page.close();
    }
  });
});
