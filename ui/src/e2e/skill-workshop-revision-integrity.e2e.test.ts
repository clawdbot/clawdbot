import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeAll, expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Skill Workshop proposal revision integrity mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "skill-workshop-revision-integrity",
);
const viewport = { height: 900, width: 1280 };
const PROPOSAL_ID = "revision-integrity-proposal";
const SKILL_KEY = "revision-integrity";
const H1_HASH = "1".repeat(64);
const H2_HASH = "2".repeat(64);
const H1 = {
  body: "Reviewed H1 draft.",
  hash: H1_HASH,
  updatedAt: "2026-08-18T10:00:00.000Z",
  version: "v1",
};
const H2 = {
  body: "Updated H2 draft requires a new review.",
  hash: H2_HASH,
  updatedAt: "2026-08-18T10:01:00.000Z",
  version: "v2",
};
const staleMessage = /Proposal changed\. Review the updated draft/i;
const staleError = {
  code: "INVALID_REQUEST",
  message: "Skill proposal revision changed.",
  details: {
    code: "SKILL_PROPOSAL_REVISION_CHANGED",
    expectedRevisionHash: H1_HASH,
    currentRevisionHash: H2_HASH,
  },
};

type ProposalRevision = typeof H1;
type ProposalStatus = "pending" | "applied" | "rejected";

const workshopFeatureMethods = [
  ...defaultControlUiFeatureMethods,
  "sessions.list",
  "skills.proposals.apply",
  "skills.proposals.inspect",
  "skills.proposals.list",
  "skills.proposals.reject",
  "skills.proposals.requestRevision",
];

function proposalManifest(revision: ProposalRevision, status: ProposalStatus = "pending") {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: revision.updatedAt,
    proposals: [
      {
        id: PROPOSAL_ID,
        kind: "create",
        status,
        title: "Revision integrity proposal",
        description: "Protect proposal decision integrity.",
        skillName: "Revision Integrity",
        skillKey: SKILL_KEY,
        createdAt: H1.updatedAt,
        updatedAt: revision.updatedAt,
        scanState: "clean",
      },
    ],
  };
}

function proposalInspect(revision: ProposalRevision, status: ProposalStatus = "pending") {
  return {
    record: {
      id: PROPOSAL_ID,
      kind: "create",
      status,
      title: "Revision integrity proposal",
      description: "Protect proposal decision integrity.",
      createdAt: H1.updatedAt,
      updatedAt: revision.updatedAt,
      proposedVersion: revision.version,
      draftHash: "d".repeat(64),
      origin: { agentId: "main", sessionKey: "main" },
      target: { skillName: "Revision Integrity", skillKey: SKILL_KEY },
    },
    revisionHash: revision.hash,
    content: `# Revision Integrity\n\n${revision.body}`,
    supportFiles: [],
  };
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new Error(`Expected object params for ${request.method}`);
  }
  return request.params as Record<string, unknown>;
}

async function setProposalRevision(
  gateway: MockGatewayControls,
  revision: ProposalRevision,
  status: ProposalStatus = "pending",
): Promise<void> {
  await gateway.setMethodResponse("skills.proposals.list", proposalManifest(revision, status));
  await gateway.setMethodResponse("skills.proposals.inspect", proposalInspect(revision, status));
}

async function openReviewedProposal(page: Page): Promise<MockGatewayControls> {
  const gateway = await installMockGateway(page, {
    featureMethods: workshopFeatureMethods,
    methodResponses: {
      "skills.proposals.list": proposalManifest(H1),
      "skills.proposals.inspect": proposalInspect(H1),
    },
  });
  const response = await page.goto(`${suite.server.baseUrl}skills/workshop`);
  expect(response?.status()).toBe(200);
  await gateway.waitForRequest("skills.proposals.list");
  await page.locator("#skill-workshop-mode-tab-board").click();
  await page.getByText(H1.body, { exact: true }).waitFor();
  return gateway;
}

async function waitForProposalRefresh(
  page: Page,
  gateway: MockGatewayControls,
  previousListCount: number,
  previousInspectCount: number,
): Promise<void> {
  await gateway.waitForRequest("skills.proposals.list", { after: previousListCount });
  await gateway.waitForRequest("skills.proposals.inspect", { after: previousInspectCount });
  await page.locator("#skill-workshop-mode-tab-board").click();
  await page.getByText(H2.body, { exact: true }).waitFor();
  await page.getByText(staleMessage).waitFor();
}

async function provePersistentStaleOutcome(page: Page): Promise<void> {
  await page.locator("#skill-workshop-mode-tab-today").click();
  await page.locator("#skill-workshop-mode-tab-board").click();
  await page.getByText(staleMessage).waitFor();
}

async function proveNoReplayAcrossReconnect(
  page: Page,
  gateway: MockGatewayControls,
  method: string,
  expectedCount: number,
): Promise<void> {
  const connectCount = (await gateway.getRequests("connect")).length;
  await gateway.closeLatest(1006, "revision-integrity-reconnect");
  await gateway.waitForRequest("connect", { after: connectCount });
  await page.getByText(H2.body, { exact: true }).waitFor();
  expect(await gateway.getRequests(method)).toHaveLength(expectedCount);
}

async function closeProofContext(params: { context: BrowserContext }): Promise<void> {
  await suite.closeBrowserContext(params.context);
}

suite.define(() => {
  beforeAll(async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
  });

  it.each([
    {
      action: "Apply",
      method: "skills.proposals.apply",
      status: "applied",
    },
    {
      action: "Reject",
      method: "skills.proposals.reject",
      status: "rejected",
    },
  ] as const)(
    "refreshes H2 and requires a second explicit $action after stale H1",
    async ({ action, method, status }) => {
      const label = action.toLowerCase();
      const caseDir = path.join(artifactDir, label);
      await mkdir(caseDir, { recursive: true });
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
      });
      const page = await context.newPage();
      try {
        const gateway = await openReviewedProposal(page);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(caseDir, "01-reviewed-h1.png"),
        });

        const actionCount = (await gateway.getRequests(method)).length;
        const listCount = (await gateway.getRequests("skills.proposals.list")).length;
        const inspectCount = (await gateway.getRequests("skills.proposals.inspect")).length;
        await gateway.deferNext(method, { expectedRevisionHash: H1_HASH });
        await page.locator(".sw-action-bar").getByRole("button", { name: action }).click();

        const staleRequest = await gateway.waitForRequest(method, { after: actionCount });
        expect(requestParams(staleRequest)).toEqual({
          agentId: "main",
          expectedRevisionHash: H1_HASH,
          proposalId: PROPOSAL_ID,
        });

        await setProposalRevision(gateway, H2);
        await gateway.rejectDeferred(method, staleError);
        await waitForProposalRefresh(page, gateway, listCount, inspectCount);
        expect(await gateway.getRequests(method)).toHaveLength(actionCount + 1);
        await provePersistentStaleOutcome(page);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(caseDir, "02-stale-h2-review-required.png"),
        });

        await proveNoReplayAcrossReconnect(page, gateway, method, actionCount + 1);

        const secondActionCount = (await gateway.getRequests(method)).length;
        const secondListCount = (await gateway.getRequests("skills.proposals.list")).length;
        const secondInspectCount = (await gateway.getRequests("skills.proposals.inspect")).length;
        await gateway.deferNext(method, { expectedRevisionHash: H2_HASH });
        await page.locator(".sw-action-bar").getByRole("button", { name: action }).click();
        const currentRequest = await gateway.waitForRequest(method, { after: secondActionCount });
        expect(requestParams(currentRequest)).toEqual({
          agentId: "main",
          expectedRevisionHash: H2_HASH,
          proposalId: PROPOSAL_ID,
        });

        await setProposalRevision(gateway, H2, status);
        // The action RPC returns the committed terminal record (apply wraps it
        // in { record, targetSkillFile }, reject returns the record itself), so
        // the UI's completion authority confirms the action and refreshes.
        const actionRecord = proposalInspect(H2, status).record;
        await gateway.resolveDeferred(
          method,
          method === "skills.proposals.apply"
            ? { record: actionRecord, targetSkillFile: `skills/${SKILL_KEY}/SKILL.md` }
            : actionRecord,
        );
        await gateway.waitForRequest("skills.proposals.list", { after: secondListCount });
        await gateway.waitForRequest("skills.proposals.inspect", { after: secondInspectCount });
        await page
          .locator(".sw-lifecycle-tab")
          .filter({ hasText: status === "applied" ? "Applied" : "Rejected" })
          .click();
        await page.getByText(H2.body, { exact: true }).waitFor();
        expect(await gateway.getRequests(method)).toHaveLength(secondActionCount + 1);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(caseDir, "03-second-explicit-h2.png"),
        });
      } finally {
        await closeProofContext({ context });
      }
    },
  );

  it("returns a stale natural Revision to H2 without retrying H1", async () => {
    const caseDir = path.join(artifactDir, "revision");
    await mkdir(caseDir, { recursive: true });
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    try {
      const gateway = await openReviewedProposal(page);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(caseDir, "01-reviewed-h1.png"),
      });

      await page.locator(".sw-action-bar").getByRole("button", { name: "Revise" }).click();
      const revisionInput = page.locator(".sw-revision-dialog__input");
      const instructions = "Preserve the reviewed H1 workflow and tighten its checks.";
      await revisionInput.fill(instructions);
      const revisionCount = (await gateway.getRequests("skills.proposals.requestRevision")).length;
      const listCount = (await gateway.getRequests("skills.proposals.list")).length;
      const inspectCount = (await gateway.getRequests("skills.proposals.inspect")).length;
      await gateway.deferNext("skills.proposals.requestRevision", {
        expectedRevisionHash: H1_HASH,
      });
      await page.getByRole("button", { name: "Send revision", exact: true }).click();

      const staleRequest = await gateway.waitForRequest("skills.proposals.requestRevision", {
        after: revisionCount,
      });
      expect(requestParams(staleRequest)).toMatchObject({
        agentId: "main",
        expectedRevisionHash: H1_HASH,
        instructions,
        proposalId: PROPOSAL_ID,
        sessionKey: "main",
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.waitForURL(/\/skills\/workshop(?:[?#].*)?$/u);

      await setProposalRevision(gateway, H2);
      await gateway.rejectDeferred("skills.proposals.requestRevision", staleError);
      await waitForProposalRefresh(page, gateway, listCount, inspectCount);
      expect(await gateway.getRequests("skills.proposals.requestRevision")).toHaveLength(
        revisionCount + 1,
      );
      expect(await page.locator(".chat-queue__retry").count()).toBe(0);
      await provePersistentStaleOutcome(page);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(caseDir, "02-stale-h2-review-required.png"),
      });

      await proveNoReplayAcrossReconnect(
        page,
        gateway,
        "skills.proposals.requestRevision",
        revisionCount + 1,
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await page.locator(".sw-action-bar").getByRole("button", { name: "Revise" }).click();
      const reviewedInstructions = "Revise the newly reviewed H2 draft.";
      await page.locator(".sw-revision-dialog__input").fill(reviewedInstructions);
      const secondRevisionCount = (await gateway.getRequests("skills.proposals.requestRevision"))
        .length;
      await gateway.deferNext("skills.proposals.requestRevision", {
        expectedRevisionHash: H2_HASH,
      });
      await page.getByRole("button", { name: "Send revision", exact: true }).click();
      const currentRequest = await gateway.waitForRequest("skills.proposals.requestRevision", {
        after: secondRevisionCount,
      });
      const currentParams = requestParams(currentRequest);
      expect(currentParams).toMatchObject({
        agentId: "main",
        expectedRevisionHash: H2_HASH,
        instructions: reviewedInstructions,
        proposalId: PROPOSAL_ID,
        sessionKey: "main",
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(caseDir, "03-second-explicit-h2.png"),
      });

      const runId = currentParams.idempotencyKey;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Expected the revision request to carry an idempotency key");
      }
      await gateway.resolveDeferred("skills.proposals.requestRevision", {
        runId,
        status: "started",
      });
      await page.waitForURL(/\/chat(?:[/?#].*)?$/u);
      expect(await gateway.getRequests("skills.proposals.requestRevision")).toHaveLength(
        secondRevisionCount + 1,
      );
    } finally {
      await closeProofContext({ context });
    }
  });
});
