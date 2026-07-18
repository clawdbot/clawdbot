// Control UI E2E tests cover Gateway question cards through the mocked WebSocket.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "question-flow");

let browser: Browser;
let context: BrowserContext | undefined;
let server: ControlUiE2eServer;

function questionRecord(
  id: string,
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
    isOther?: boolean;
  }>,
) {
  const createdAtMs = Date.now();
  return {
    id,
    questions,
    agentId: "main",
    sessionKey: "main",
    createdAtMs,
    expiresAtMs: createdAtMs + 15 * 60_000,
    status: "pending" as const,
  };
}

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

async function openQuestionPage() {
  context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "question.list": { questions: [] },
    },
    sessionKey: "main",
  });
  await page.goto(`${server.baseUrl}chat`);
  await gateway.waitForRequest("question.list");
  return { gateway, page };
}

function cardFor(page: Page, prompt: string) {
  return page.locator("openclaw-chat-question").filter({ hasText: prompt });
}

async function emitRequested(
  gateway: MockGatewayControls,
  record: ReturnType<typeof questionRecord>,
) {
  await gateway.emitGatewayEvent("question.requested", record);
}

describeControlUiE2e("Control UI Gateway question flow", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterEach(async () => {
    await context?.close().catch(() => {});
    context = undefined;
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("renders and resolves a single-choice question in the active thread", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = questionRecord("question-deploy-target", [
      {
        id: "deploy_target",
        header: "Deploy",
        question: "Where should I deploy?",
        options: [
          {
            label: "Staging (Recommended)",
            description: "Validate the release before production.",
          },
          {
            label: "Production",
            description: "Deploy directly to live users.",
          },
        ],
        isOther: true,
      },
    ]);

    await emitRequested(gateway, request);
    const card = cardFor(page, "Where should I deploy?");
    await card.waitFor();
    await expect.poll(() => card.getByText("Deploy", { exact: true }).count()).toBe(1);
    await expect
      .poll(() => card.getByText("Staging (Recommended)", { exact: true }).count())
      .toBe(1);
    await expect.poll(() => card.getByText("Production", { exact: true }).count()).toBe(1);
    await expect
      .poll(() => card.getByRole("textbox", { name: "Your own answer for Deploy" }).count())
      .toBe(1);
    await expect.poll(() => card.getByRole("button", { name: "Submit answer" }).count()).toBe(1);
    await screenshot(page, "01-question-pending.png");

    const staging = card.locator('input[type="radio"]').first();
    await staging.check();
    await card.getByRole("button", { name: "Submit answer" }).click();
    const resolveRequest = await gateway.waitForRequest("question.resolve");
    expect(resolveRequest.params).toEqual({
      id: request.id,
      answers: {
        answers: {
          deploy_target: { answers: ["Staging (Recommended)"] },
        },
      },
    });

    await gateway.emitGatewayEvent("question.resolved", {
      id: request.id,
      status: "answered",
      answers: {
        answers: {
          deploy_target: { answers: ["Staging (Recommended)"] },
        },
      },
    });
    await card.getByText("Answered", { exact: true }).waitFor();
    await expect.poll(() => staging.isChecked()).toBe(true);
    await expect.poll(() => staging.isDisabled()).toBe(true);
    await screenshot(page, "02-question-answered.png");
  });

  it("submits multi-select answers as an array", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = questionRecord("question-release-checks", [
      {
        id: "release_checks",
        header: "Checks",
        question: "Which release checks should I run?",
        options: [
          { label: "Tests", description: "Run focused automated tests." },
          { label: "Docs", description: "Verify documentation changes." },
          { label: "Metrics", description: "Inspect performance metrics." },
          { label: "Rollback", description: "Prepare a rollback plan." },
        ],
        multiSelect: true,
      },
    ]);

    await emitRequested(gateway, request);
    const card = cardFor(page, "Which release checks should I run?");
    await card.waitFor();
    const options = card.locator('input[type="checkbox"]');
    await options.nth(0).check();
    await options.nth(2).check();
    await expect.poll(() => options.nth(0).isChecked()).toBe(true);
    await expect.poll(() => options.nth(2).isChecked()).toBe(true);
    await screenshot(page, "03-question-multiselect.png");

    await card.getByRole("button", { name: "Submit answer" }).click();
    const resolveRequest = await gateway.waitForRequest("question.resolve");
    expect(resolveRequest.params).toEqual({
      id: request.id,
      answers: {
        answers: {
          release_checks: { answers: ["Tests", "Metrics"] },
        },
      },
    });
  });

  it("renders answered-elsewhere and expired terminal states", async () => {
    const { gateway, page } = await openQuestionPage();
    const elsewhere = questionRecord("question-external-answer", [
      {
        id: "approval_path",
        header: "Approval",
        question: "Who should approve the release?",
        options: [{ label: "Maintainer" }, { label: "Release manager" }],
      },
    ]);
    const expired = questionRecord("question-expired-window", [
      {
        id: "release_window",
        header: "Window",
        question: "When should the release start?",
        options: [{ label: "Now" }, { label: "Tomorrow" }],
      },
    ]);

    await emitRequested(gateway, elsewhere);
    await emitRequested(gateway, expired);
    const elsewhereCard = cardFor(page, "Who should approve the release?");
    const expiredCard = cardFor(page, "When should the release start?");
    await elsewhereCard.waitFor();
    await expiredCard.waitFor();

    await gateway.emitGatewayEvent("question.resolved", {
      id: elsewhere.id,
      status: "answered",
      answers: {
        answers: {
          approval_path: { answers: ["Release manager"] },
        },
      },
    });
    await elsewhereCard.getByText("Answered elsewhere", { exact: true }).waitFor();
    const elsewhereAnswer = elsewhereCard.locator('input[type="radio"]').nth(1);
    await expect.poll(() => elsewhereAnswer.isChecked()).toBe(true);
    await expect.poll(() => elsewhereAnswer.isDisabled()).toBe(true);

    await gateway.emitGatewayEvent("question.resolved", {
      id: expired.id,
      status: "expired",
    });
    await expiredCard.getByText("Expired", { exact: true }).waitFor();
    await expect
      .poll(() => expiredCard.locator('input[type="radio"]').first().isDisabled())
      .toBe(true);
    await screenshot(page, "04-question-terminal-states.png");
  });
});
