import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/applied-revision-diff");

let browser: Browser;
let server: ControlUiE2eServer;

function appliedProposal(id: string, updatedAt: string) {
  return {
    createdAt: updatedAt,
    description: "Keep the release procedure accurate.",
    id,
    kind: "update",
    scanState: "clean",
    skillKey: "deploy-review",
    skillName: "Deploy Review",
    status: "applied",
    title: "Deploy review",
    updatedAt,
  };
}

function inspectResponse(
  proposal: ReturnType<typeof appliedProposal>,
  content: string,
  version: string,
) {
  return {
    content,
    record: {
      ...proposal,
      proposedVersion: version,
      target: { skillKey: proposal.skillKey, skillName: proposal.skillName },
    },
    supportFiles: [],
  };
}

function inspectedProposalId(request: MockGatewayRequest): unknown {
  const params = request.params;
  if (!params || typeof params !== "object" || !("proposalId" in params)) {
    throw new Error("Expected skills.proposals.inspect params");
  }
  return params.proposalId;
}

describeControlUiE2e("Skill Workshop applied revision diff mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows a compact revision diff and switches to the full body", async () => {
    const previous = appliedProposal("proposal-v1", "2026-08-16T10:00:00.000Z");
    const latest = appliedProposal("proposal-v2", "2026-08-17T10:00:00.000Z");
    const previousBody = "# Deploy review\n\n## Steps\n1. Verify package.\n2. Publish release.";
    const latestBody = "# Deploy review\n\n## Steps\n1. Verify package.\n2. Publish package.";
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "skills.proposals.inspect": {
          cases: [
            {
              match: { proposalId: latest.id },
              response: inspectResponse(latest, latestBody, "v2"),
            },
            {
              match: { proposalId: previous.id },
              response: inspectResponse(previous, previousBody, "v1"),
            },
          ],
        },
        "skills.proposals.list": {
          proposals: [latest, previous],
          schema: "openclaw.skill-workshop.proposals-manifest.v1",
          updatedAt: latest.updatedAt,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills/workshop`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.proposals.list");
      await page.locator("#skill-workshop-mode-tab-board").click();
      await page.locator(".sw-lifecycle-tab", { hasText: "Applied" }).click();

      const changes = page.getByRole("button", { name: "Changes", exact: true });
      await expect.poll(() => changes.getAttribute("aria-pressed")).toBe("true");
      await page.locator(".sw-diff__row--add", { hasText: "Publish package." }).waitFor();
      await page.locator(".sw-diff__row--del", { hasText: "Publish release." }).waitFor();
      expect((await page.locator(".sw-diff__stat").textContent())?.replace(/\s+/gu, "")).toBe(
        "+1-1",
      );
      const inspectRequests = await gateway.getRequests("skills.proposals.inspect");
      expect(new Set(inspectRequests.map(inspectedProposalId))).toEqual(
        new Set([latest.id, previous.id]),
      );
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(artifactDir, "01-changes.png"),
      });

      await page.getByRole("button", { name: "Full body", exact: true }).click();
      await page.getByText("Publish package.", { exact: true }).waitFor();
      expect(await page.locator(".sw-diff").count()).toBe(0);
      expect(await gateway.getRequests("skills.proposals.inspect")).toHaveLength(
        inspectRequests.length,
      );
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(artifactDir, "02-full-body.png"),
      });
    } finally {
      await context.close();
    }
  });

  it.each([
    { label: "late-only", changedIndex: 650, hasVisibleChange: false },
    { label: "visible-only", changedIndex: 500, hasVisibleChange: true },
  ])("directs $label changes to the full body without exact totals", async (scenario) => {
    const previous = appliedProposal("proposal-long-v1", "2026-08-16T10:00:00.000Z");
    const latest = appliedProposal("proposal-long-v2", "2026-08-17T10:00:00.000Z");
    const previousLines = Array.from({ length: 700 }, (_, index) => `Procedure line ${index}`);
    const latestLines = [...previousLines];
    const changedText = `Changed procedure at line ${scenario.changedIndex}`;
    latestLines[scenario.changedIndex] = changedText;
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "skills.proposals.inspect": {
          cases: [
            {
              match: { proposalId: latest.id },
              response: inspectResponse(latest, latestLines.join("\n"), "v2"),
            },
            {
              match: { proposalId: previous.id },
              response: inspectResponse(previous, previousLines.join("\n"), "v1"),
            },
          ],
        },
        "skills.proposals.list": {
          proposals: [latest, previous],
          schema: "openclaw.skill-workshop.proposals-manifest.v1",
          updatedAt: latest.updatedAt,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills/workshop`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.proposals.list");
      await page.locator("#skill-workshop-mode-tab-board").click();
      await page.locator(".sw-lifecycle-tab", { hasText: "Applied" }).click();

      const notice = page.locator(".sw-diff__notice");
      await notice.waitFor();
      expect(await notice.textContent()).toContain("This comparison is truncated.");
      expect(await notice.textContent()).toContain("Switch to Full body");
      expect(await page.locator(".sw-diff__stat").count()).toBe(0);
      expect((await page.locator(".sw-diff__row--add").count()) > 0).toBe(
        scenario.hasVisibleChange,
      );
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(artifactDir, `03-${scenario.label}-change.png`),
      });

      await page.getByRole("button", { name: "Full body", exact: true }).click();
      await expect.poll(() => page.locator(".sw-body-card").textContent()).toContain(changedText);
    } finally {
      await context.close();
    }
  });
});
