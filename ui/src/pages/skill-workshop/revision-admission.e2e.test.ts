import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Skill Workshop revision admission",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const ISO_NOW = "2026-08-18T12:00:00.000Z";
const MAIN_REVISION_HASH = "a".repeat(64);

function proposal() {
  return {
    id: "proposal-main",
    kind: "create",
    status: "pending",
    title: "Main Inbox Cleaner",
    description: "Clean main inboxes safely.",
    skillName: "Main Inbox Cleaner",
    skillKey: "main-inbox-cleaner",
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    scanState: "clean",
  };
}

function inspectResult() {
  const entry = proposal();
  return {
    content: `# ${entry.title}\n\nReview unread mail.`,
    record: {
      ...entry,
      proposedVersion: "v1",
      origin: { agentId: "main", sessionKey: "agent:main:workshop" },
      target: { skillKey: entry.skillKey, skillName: entry.skillName },
    },
    revisionHash: MAIN_REVISION_HASH,
    supportFiles: [],
  };
}

function sessionList() {
  return {
    count: 1,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:workshop",
        agentId: "main",
        sessionId: "session-main-workshop",
        archived: false,
        hasActiveRun: false,
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

function params(request: MockGatewayRequest): Record<string, unknown> {
  return request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};
}

async function openRevision(page: Page, instructions: string): Promise<void> {
  const board = page.locator("#skill-workshop-mode-tab-board");
  await board.waitFor();
  await board.click();
  const revise = page.getByRole("button", { name: "Revise", exact: true });
  await revise.waitFor();
  await revise.click();
  const textarea = page.locator(".sw-revision-dialog__input");
  await textarea.fill(instructions);
  await page.getByRole("button", { name: "Send revision", exact: true }).click();
}

async function enterWorkshop(page: Page): Promise<void> {
  await page.locator("#plugins-tab-workshop").click();
  await waitForControlUiRoute(page, {
    pathname: "/skills/workshop",
    routeId: "skill-workshop",
  });
}

async function leaveWorkshop(page: Page): Promise<void> {
  await page.goBack();
  await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
}

function gatewayScenario() {
  const roster = [{ id: "main", identity: { name: "Main" }, name: "Main" }];
  return {
    assistantAgentId: "main",
    defaultAgentId: "main",
    featureMethods: [
      "agents.list",
      "chat.metadata",
      "chat.startup",
      "sessions.list",
      "skills.proposals.inspect",
      "skills.proposals.list",
      "skills.proposals.requestRevision",
    ],
    methodResponses: {
      "agents.list": { agents: roster, defaultId: "main", mainKey: "main", scope: "agent" },
      "chat.startup": {
        agentsList: { agents: roster, defaultId: "main", mainKey: "main", scope: "agent" },
        messages: [],
        metadata: { models: [] },
        sessionId: "session-main-workshop",
        thinkingLevel: null,
      },
      "sessions.list": sessionList(),
      "skills.proposals.inspect": inspectResult(),
      "skills.proposals.list": {
        proposals: [proposal()],
        schema: "openclaw.skill-workshop.proposals-manifest.v1",
        updatedAt: ISO_NOW,
      },
      "skills.proposals.requestRevision": {
        runId: "revision-admitted",
        status: "started",
      },
    },
  };
}

suite.define(() => {
  it("restores a failed admission after the Workshop page is destroyed", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, gatewayScenario());
        const instructions = "Keep the operator's exact retry steps.";

        await page.goto(`${suite.server.baseUrl}skills`);
        await enterWorkshop(page);
        await gateway.deferNext("skills.proposals.requestRevision");
        await openRevision(page, instructions);
        const first = await gateway.waitForRequest("skills.proposals.requestRevision");
        expect(params(first)).toMatchObject({
          expectedRevisionHash: MAIN_REVISION_HASH,
          instructions,
          proposalId: "proposal-main",
        });

        await leaveWorkshop(page);
        await gateway.rejectDeferred("skills.proposals.requestRevision", {
          message: "Gateway owner changed before admission",
          retryable: true,
        });
        await enterWorkshop(page);

        await page.getByText(/not admitted.*retry/iu).waitFor();
        await expect
          .poll(() => page.locator(".sw-revision-dialog__input").inputValue())
          .toBe(instructions);

        await gateway.deferNext("skills.proposals.requestRevision");
        await page.getByRole("button", { name: "Send revision", exact: true }).click();
        const retry = await gateway.waitForRequest("skills.proposals.requestRevision", {
          after: 1,
        });
        expect(params(retry)).toMatchObject({
          agentId: "main",
          expectedRevisionHash: MAIN_REVISION_HASH,
          instructions,
          proposalId: "proposal-main",
          sessionId: "session-main-workshop",
          sessionKey: "agent:main:workshop",
          targetAgentId: "main",
        });
        expect(params(retry).idempotencyKey).toBe(params(first).idempotencyKey);
        await gateway.resolveDeferred("skills.proposals.requestRevision", {
          runId: "revision-retry-admitted",
          status: "started",
        });
        await page.waitForURL(/\/chat(?:\/|$)/u);
      },
    );
  });

  it("settles overlapping admissions without replacing failed recovery", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, gatewayScenario());
        const admittedInstructions = "Preserve the admitted proposal instructions.";
        const failedInstructions = "Preserve the failed proposal instructions.";

        await page.goto(`${suite.server.baseUrl}skills`);
        await enterWorkshop(page);
        await gateway.deferNext("skills.proposals.requestRevision");
        await openRevision(page, admittedInstructions);
        await gateway.waitForRequest("skills.proposals.requestRevision");
        await leaveWorkshop(page);

        await enterWorkshop(page);
        await gateway.deferNext("skills.proposals.requestRevision");
        await openRevision(page, failedInstructions);
        await gateway.waitForRequest("skills.proposals.requestRevision", { after: 1 });
        await leaveWorkshop(page);

        const requests = await gateway.getRequests("skills.proposals.requestRevision");
        expect(requests.map(params)).toEqual([
          expect.objectContaining({
            expectedRevisionHash: MAIN_REVISION_HASH,
            instructions: admittedInstructions,
            proposalId: "proposal-main",
          }),
          expect.objectContaining({
            expectedRevisionHash: MAIN_REVISION_HASH,
            instructions: failedInstructions,
            proposalId: "proposal-main",
          }),
        ]);
        await gateway.resolveDeferred("skills.proposals.requestRevision", {
          runId: "revision-first-admitted",
          status: "started",
        });
        await gateway.rejectDeferred("skills.proposals.requestRevision", {
          message: "Second admission failed",
          retryable: true,
        });

        await enterWorkshop(page);
        await page.getByText(/not admitted.*retry/iu).waitFor();
        await expect
          .poll(() => page.locator(".sw-revision-dialog__input").inputValue())
          .toBe(failedInstructions);
        expect(await page.getByText(admittedInstructions, { exact: true }).count()).toBe(0);

        await gateway.deferNext("skills.proposals.requestRevision");
        await page.getByRole("button", { name: "Send revision", exact: true }).click();
        const retry = await gateway.waitForRequest("skills.proposals.requestRevision", {
          after: 2,
        });
        expect(params(retry)).toMatchObject({
          expectedRevisionHash: MAIN_REVISION_HASH,
          instructions: failedInstructions,
          proposalId: "proposal-main",
        });
        expect(params(retry).idempotencyKey).toBe(params(requests[1]!).idempotencyKey);
        await gateway.resolveDeferred("skills.proposals.requestRevision", {
          runId: "revision-second-admitted",
          status: "started",
        });
        await page.waitForURL(/\/chat(?:\/|$)/u);
      },
    );
  });
});
