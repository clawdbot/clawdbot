// Control UI E2E tests cover docked Gateway questions through the mocked WebSocket.
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

function historyMessages() {
  return Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text:
          index === 11
            ? "I have the release context ready. I only need your deployment choice."
            : `Release preparation note ${index + 1}: deterministic transcript content for the docked panel proof.`,
      },
    ],
    timestamp: 1_750_000_000_000 + index * 1_000,
  }));
}

async function openQuestionPage() {
  context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    historyMessages: historyMessages(),
    methodResponses: {
      "question.list": { questions: [] },
    },
    sessionKey: "main",
  });
  await page.goto(`${server.baseUrl}chat`);
  await gateway.waitForRequest("question.list");
  return { gateway, page };
}

function panelFor(page: Page, prompt: string) {
  return page.locator("openclaw-chat-question-panel").filter({ hasText: prompt });
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

  it("docks a pending question and replaces it with a compact answer summary", async () => {
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
    const panel = panelFor(page, "Where should I deploy?");
    await panel.waitFor();
    await expect
      .poll(() => page.locator(".chat-thread openclaw-chat-question-panel").count())
      .toBe(0);
    await expect.poll(() => panel.getByText("1/1", { exact: true }).count()).toBe(1);
    await expect.poll(() => panel.getByPlaceholder("Type your own answer here").count()).toBe(1);

    await expect
      .poll(async () => {
        const panelBox = await panel.boundingBox();
        const composerBox = await page.locator(".agent-chat__input").boundingBox();
        if (!panelBox || !composerBox) {
          return null;
        }
        return Math.round(composerBox.y - (panelBox.y + panelBox.height));
      })
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => {
        const panelHeight = (await panel.boundingBox())?.height ?? 0;
        const padding = await page
          .locator(".chat-thread")
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
        return padding >= panelHeight;
      })
      .toBe(true);
    await screenshot(page, "01-question-pending.png");

    await panel.getByRole("radio", { name: /Staging \(Recommended\)/ }).click();
    await panel.getByRole("button", { name: "Submit", exact: true }).click();
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
    await expect.poll(() => panel.count()).toBe(0);
    const summary = page.locator(".chat-question-summary").filter({ hasText: "Deploy:" });
    await summary.waitFor();
    await expect
      .poll(() => summary.getByText("Staging (Recommended)", { exact: true }).count())
      .toBe(1);
    await screenshot(page, "02-question-answered.png");
  });

  it("keeps multi-select on one step and submits labels as an array", async () => {
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
    const panel = panelFor(page, "Which release checks should I run?");
    await panel.waitFor();
    await panel.getByRole("checkbox", { name: /Tests/ }).click();
    await panel.getByRole("checkbox", { name: /Metrics/ }).click();
    await expect
      .poll(() => panel.getByRole("checkbox", { name: /Tests/ }).getAttribute("aria-checked"))
      .toBe("true");
    await expect
      .poll(() => panel.getByRole("checkbox", { name: /Metrics/ }).getAttribute("aria-checked"))
      .toBe("true");
    await screenshot(page, "03-question-multiselect.png");

    await panel.getByRole("button", { name: "Submit", exact: true }).click();
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

  it("shows a 1/2 stepper with answered and expired summaries", async () => {
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
    await gateway.emitGatewayEvent("question.resolved", {
      id: elsewhere.id,
      status: "answered",
      answers: { answers: { approval_path: { answers: ["Release manager"] } } },
    });
    await emitRequested(gateway, expired);
    await gateway.emitGatewayEvent("question.resolved", {
      id: expired.id,
      status: "expired",
    });

    const stepper = questionRecord("question-release-plan", [
      {
        id: "channel",
        header: "Channel",
        question: "Which release channel should I use?",
        options: [{ label: "Beta" }, { label: "Stable" }],
        isOther: true,
      },
      {
        id: "notes",
        header: "Notes",
        question: "Which notes should I include?",
        options: [{ label: "Highlights" }, { label: "Full details" }],
        multiSelect: true,
        isOther: true,
      },
    ]);
    await emitRequested(gateway, stepper);

    const panel = panelFor(page, "Which release channel should I use?");
    await panel.waitFor();
    await expect.poll(() => panel.getByText("1/2", { exact: true }).count()).toBe(1);
    await expect
      .poll(() =>
        page.locator(".chat-question-summary").filter({ hasText: "Release manager" }).count(),
      )
      .toBe(1);
    await expect
      .poll(() => page.locator(".chat-question-summary").filter({ hasText: "Expired" }).count())
      .toBe(1);
    await screenshot(page, "04-question-terminal-states.png");
  });
});
