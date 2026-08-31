// Control UI E2E tests cover composer-replacing Gateway questions through the mocked WebSocket.
import path from "node:path";
import type { Question, QuestionResolveResult } from "@openclaw/gateway-protocol";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, afterEach, expect, it } from "vitest";
import type { SessionsListResult } from "../api/types.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { chatThreadDistanceFromBottom, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Gateway question flow",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("question-flow");
  }
});
const mainSessionKey = "agent:main:main";
const questionSessionKey = "agent:main:question-proof";

let context: BrowserContext | undefined;
function questionRecord(id: string, questions: Question[]) {
  const createdAtMs = Date.now();
  return {
    id,
    questions,
    agentId: "main",
    sessionKey: questionSessionKey,
    createdAtMs,
    expiresAtMs: createdAtMs + 15 * 60_000,
    status: "pending" as const,
  };
}

function secretStoreQuestion(id: string) {
  return questionRecord(id, [
    {
      questionId: "api_key",
      header: "API key",
      question: "Provide the deployment API key",
      options: [],
      isSecret: true,
      secretStore: {
        name: "DEPLOY_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.test"],
        reason: "Publish the release artifacts.",
      },
      secretStoreExisting: {
        updatedAtMs: Date.now() - 60_000,
        updatedBy: "release-operator",
      },
    },
  ]);
}

function storedSecretAnswer(): QuestionResolveResult {
  return { status: "answered", answers: { answers: { api_key: ["stored"] } } };
}

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
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
            : `Release preparation note ${index + 1}: deterministic transcript content for the question panel proof.`,
      },
    ],
    timestamp: 1_750_000_000_000 + index * 1_000,
  }));
}

async function openQuestionPage(viewport = { height: 900, width: 1440 }) {
  context = await suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods: [
      "chat.abort",
      "chat.metadata",
      "chat.startup",
      "question.get",
      "question.list",
      "question.resolve",
      "sessions.create",
      "sessions.patch",
    ],
    historyMessages: historyMessages(),
    methodResponses: {
      "question.list": { questions: [] },
      "sessions.list": {
        ts: Date.now(),
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
        sessions: [
          {
            key: mainSessionKey,
            kind: "direct",
            label: "Home",
            updatedAt: Date.now() - 1_000,
          },
          {
            key: questionSessionKey,
            kind: "direct",
            label: "Question proof",
            updatedAt: Date.now(),
          },
        ],
      } satisfies SessionsListResult,
    },
    // The handshake must advertise the genuine canonical main; the question
    // lives in its own existing thread so the real sidebar can render its row.
    sessionKey: mainSessionKey,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, questionSessionKey));
  // Chat and sidebar each own a projection; both must bind to the advertised
  // real client before a lost-broadcast test can prove cross-surface delivery.
  await expect
    .poll(async () => (await gateway.getRequests("question.list")).length)
    .toBeGreaterThanOrEqual(2);
  const startup = await gateway.waitForRequest("chat.startup");
  expect(startup.params).toEqual(expect.objectContaining({ sessionKey: questionSessionKey }));
  const compactMobileViewport =
    viewport.width <= 768 ||
    (viewport.width <= 932 && viewport.height <= 500 && viewport.width > viewport.height);
  await page
    .locator(`[data-session-key="${questionSessionKey}"]`)
    .first()
    .waitFor({ state: compactMobileViewport ? "attached" : "visible" });
  return { gateway, page };
}

function panelFor(page: Page, prompt: string) {
  return page.locator("openclaw-chat-question-panel").filter({ hasText: prompt });
}

async function expectQuestionAttention(page: Page, present: boolean): Promise<void> {
  const session = page.locator(`[data-session-key="${questionSessionKey}"]`).first();
  const expectedCount = present ? 1 : 0;
  await expect
    .poll(() => session.locator('[data-session-attention="question"]').count())
    .toBe(expectedCount);
  await expect
    .poll(() => session.getByText("Waiting for your answer", { exact: true }).count())
    .toBe(expectedCount);
}

async function emitRequested(
  gateway: MockGatewayControls,
  record: ReturnType<typeof questionRecord>,
) {
  await gateway.emitGatewayEvent("question.requested", record);
}

function scrollRegressionQuestion(id: string, prompt: string) {
  return questionRecord(id, [
    {
      questionId: "release_strategy",
      header: "Strategy",
      question: prompt,
      options: Array.from({ length: 4 }, (_, index) => ({
        label: `Release strategy ${index + 1}`,
        description: `Deterministic option ${index + 1} makes the rendered panel exceed the near-bottom threshold after layout, proving resize reconciliation follows explicit user intent instead of stale geometry.`,
      })),
      isOther: true,
    },
  ]);
}

suite.define(() => {
  afterEach(async () => {
    await context?.close().catch(() => {});
    context = undefined;
  });

  it("settles a live-edge transcript after a question enters footer flow", async () => {
    const { gateway, page } = await openQuestionPage();
    await waitForChatScrollIdle(page);
    await expect
      .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);

    const prompt = "Which detailed release strategy should I use?";
    await emitRequested(gateway, scrollRegressionQuestion("question-live-edge-scroll", prompt));
    const panel = panelFor(page, prompt);
    await panel.waitFor();
    await waitForChatScrollIdle(page);

    await expect
      .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    await expect
      .poll(async () => {
        const panelBox = await panel.boundingBox();
        const conversationBox = await page.locator(".chat-main__conversation").boundingBox();
        return Boolean(
          panelBox &&
          conversationBox &&
          panelBox.y >= conversationBox.y - 1 &&
          panelBox.y + panelBox.height <= conversationBox.y + conversationBox.height + 1,
        );
      })
      .toBe(true);
    await expect.poll(() => page.getByRole("button", { name: "Scroll to latest" }).count()).toBe(0);
    await screenshot(page, "05-question-live-edge-scroll.png");
  });

  it("preserves explicit backscroll and keeps the latest arrow above the question", async () => {
    const { gateway, page } = await openQuestionPage();
    await waitForChatScrollIdle(page);
    const thread = page.locator(".chat-thread");
    await thread.hover();
    await page.mouse.wheel(0, -600);
    await expect
      .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
      .toBeGreaterThan(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    const scrollToLatest = page.getByRole("button", { name: "Scroll to latest" });
    await scrollToLatest.waitFor({ state: "visible", timeout: 10_000 });
    await waitForChatScrollIdle(page);
    const readingScrollTop = await thread.evaluate((element) => element.scrollTop);

    const prompt = "Which detailed release strategy should stay below my reading position?";
    await emitRequested(gateway, scrollRegressionQuestion("question-backscroll-position", prompt));
    const panel = panelFor(page, prompt);
    await panel.waitFor();
    await waitForChatScrollIdle(page);

    await expect
      .poll(
        async () =>
          Math.abs((await thread.evaluate((element) => element.scrollTop)) - readingScrollTop),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(2);
    await scrollToLatest.waitFor({ state: "visible", timeout: 10_000 });
    await expect
      .poll(async () => {
        const arrowBox = await scrollToLatest.boundingBox();
        const panelBox = await panel.boundingBox();
        return Boolean(arrowBox && panelBox && arrowBox.y + arrowBox.height <= panelBox.y);
      })
      .toBe(true);
    await screenshot(page, "06-question-backscroll-arrow.png");
  });

  it.each([
    { height: 844, screenshotName: "portrait", width: 390 },
    { height: 390, screenshotName: "landscape", width: 844 },
  ])(
    "joins a collapsed mobile question and composer into one $screenshotName surface",
    async ({ height, screenshotName, width }) => {
      const { gateway, page } = await openQuestionPage({ height, width });
      const prompt = "Which progress note should I use?";
      await emitRequested(
        gateway,
        questionRecord("question-mobile-compound", [
          {
            questionId: "progress_note",
            header: "Progress note",
            question: prompt,
            options: [
              { label: "Concise", description: "Keep the update short." },
              { label: "Detailed", description: "Include the supporting evidence." },
            ],
          },
        ]),
      );

      const panel = panelFor(page, prompt);
      await panel.waitFor();
      await panel.locator(".chat-question-panel__collapse").click();
      const shell = page.locator(".agent-chat__composer-shell");
      const composer = shell.locator(".agent-chat__input");
      await composer.waitFor();
      await screenshot(page, `07-question-mobile-compound-${screenshotName}.png`);

      expect(
        await shell.evaluate((element) => {
          const collapsedPanel = element.querySelector<HTMLElement>(
            ".chat-question-panel--collapsed",
          );
          const input = element.querySelector<HTMLElement>(".agent-chat__input");
          if (!collapsedPanel || !input) {
            throw new Error("expected collapsed question and composer");
          }
          const shellBox = element.getBoundingClientRect();
          const panelBox = collapsedPanel.getBoundingClientRect();
          const inputBox = input.getBoundingClientRect();
          return {
            composerBorder: getComputedStyle(input).borderTopWidth,
            joined: Math.abs(panelBox.bottom - inputBox.top) <= 1,
            panelBorder: getComputedStyle(collapsedPanel).borderTopWidth,
            rowHeight: Math.round(panelBox.height),
            shellBorder: getComputedStyle(element).borderTopWidth,
            shellContainsChildren:
              panelBox.left >= shellBox.left - 1 &&
              inputBox.left >= shellBox.left - 1 &&
              panelBox.right <= shellBox.right + 1 &&
              inputBox.right <= shellBox.right + 1,
          };
        }),
      ).toEqual({
        composerBorder: "0px",
        joined: true,
        panelBorder: "0px",
        rowHeight: 48,
        shellBorder: "1px",
        shellContainsChildren: true,
      });

      await composer.locator(".agent-chat__composer-combobox > textarea").focus();
      await expect
        .poll(() => composer.evaluate((element) => getComputedStyle(element).boxShadow))
        .toBe("none");
      await page.evaluate(() => {
        document.documentElement.dataset.themeMode = "light";
      });
      await expect
        .poll(() => composer.evaluate((element) => getComputedStyle(element).boxShadow))
        .toBe("none");
      await composer.evaluate((element) => {
        element.classList.add("agent-chat__input--dictating");
      });
      await expect
        .poll(() => composer.evaluate((element) => getComputedStyle(element).boxShadow))
        .toBe("none");
    },
  );

  it("restores the composer and its draft from an authoritative answer without a resolution event", async () => {
    const { gateway, page } = await openQuestionPage();
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("Keep this release note draft");
    const request = questionRecord("question-deploy-target", [
      {
        questionId: "deploy_target",
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
    await expectQuestionAttention(page, true);
    await expect
      .poll(() => page.locator(".chat-thread openclaw-chat-question-panel").count())
      .toBe(0);
    await expect.poll(() => panel.getByText("1/1", { exact: true }).count()).toBe(1);
    await expect.poll(() => panel.getByPlaceholder("Type your own answer here").count()).toBe(1);
    await expect.poll(() => page.locator(".agent-chat__input").count()).toBe(0);
    await expect.poll(() => page.locator(".agent-chat__composer-footer").count()).toBe(0);
    await expect
      .poll(() =>
        panel
          .locator(".chat-question-panel")
          .evaluate((element) => document.activeElement === element),
      )
      .toBe(true);

    await expect
      .poll(async () => {
        const panelBox = await panel.boundingBox();
        const shellBox = await page.locator(".agent-chat__composer-shell").boundingBox();
        if (!panelBox || !shellBox) {
          return null;
        }
        return {
          left: Math.round(panelBox.x - shellBox.x),
          width: Math.round(panelBox.width - shellBox.width),
        };
      })
      .toEqual({ left: 0, width: 0 });
    await screenshot(page, "01-question-pending.png");

    await panel.locator(".chat-question-panel__collapse").click();
    await composer.waitFor();
    await expect.poll(() => composer.inputValue()).toBe("Keep this release note draft");
    await expect
      .poll(() => composer.evaluate((element) => document.activeElement === element))
      .toBe(true);
    await page.locator(".chat-question-panel__collapsed-button").click();
    await expect.poll(() => page.locator(".agent-chat__input").count()).toBe(0);
    await expect
      .poll(() =>
        panel
          .locator(".chat-question-panel")
          .evaluate((element) => document.activeElement === element),
      )
      .toBe(true);

    const answers = { answers: { deploy_target: ["Staging (Recommended)"] } };
    await gateway.setMethodResponse("question.resolve", {
      status: "answered",
      answers,
    } satisfies QuestionResolveResult);
    await panel.getByRole("radio", { name: /Staging \(Recommended\)/ }).click();
    await panel.getByRole("button", { name: "Submit", exact: true }).click();
    const resolveRequest = await gateway.waitForRequest("question.resolve");
    expect(resolveRequest.params).toEqual({ id: request.id, answers });

    await expect.poll(() => panel.count()).toBe(0);
    await expectQuestionAttention(page, false);
    const summary = page.locator(".chat-question-summary").filter({ hasText: "Deploy:" });
    await summary.waitFor();
    await expect
      .poll(() => summary.getByText("Staging (Recommended)", { exact: true }).count())
      .toBe(1);
    await composer.waitFor();
    await expect.poll(() => composer.inputValue()).toBe("Keep this release note draft");
    await expect
      .poll(() => composer.evaluate((element) => document.activeElement === element))
      .toBe(true);
    await screenshot(page, "02-question-answered.png");
  });

  it("masks a store-bound secret and resolves it with edited hosts without echoing the value", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = secretStoreQuestion("question-store-secret-success");
    const fakeSecret = "fake-secret-never-use-browser-proof-123";
    await gateway.setMethodResponse("question.resolve", storedSecretAnswer());
    await emitRequested(gateway, request);

    const panel = panelFor(page, "Provide the deployment API key");
    await panel.waitFor();
    await expect.poll(() => panel.getByText("Requested by main", { exact: false }).count()).toBe(1);
    await expect.poll(() => panel.getByText("Publish the release artifacts.").count()).toBe(1);
    await expect
      .poll(() => panel.getByText("Replaces DEPLOY_API_KEY", { exact: false }).count())
      .toBe(1);
    const secretInput = panel.locator('input[type="password"]');
    await expect.poll(() => secretInput.count()).toBe(1);
    expect(await secretInput.getAttribute("autocomplete")).toBe("off");
    const hostsInput = panel.locator(".chat-question-panel__hosts");
    expect(await hostsInput.inputValue()).toBe("api.example.test");
    await screenshot(page, "07-secret-store-pending.png");

    await secretInput.fill(fakeSecret);
    await hostsInput.fill("api.example.test, uploads.example.test extra.example.test");
    expect(await page.locator("body").textContent()).not.toContain(fakeSecret);
    expect(await page.locator("body").evaluate((element) => element.innerHTML)).not.toContain(
      fakeSecret,
    );
    await screenshot(page, "08-secret-store-masked-input.png");

    await panel.getByRole("button", { name: "Submit", exact: true }).click();
    const resolveRequest = await gateway.waitForRequest("question.resolve");
    expect(resolveRequest.params).toEqual({
      id: request.id,
      answers: { answers: { api_key: [fakeSecret] } },
      secretStoreAllowedHosts: ["api.example.test", "uploads.example.test", "extra.example.test"],
    });
    await expect.poll(() => panel.count()).toBe(0);
    const summary = page.locator(".chat-question-summary").filter({ hasText: "API key:" });
    await summary.waitFor();
    await expect.poll(() => summary.getByText("Answered", { exact: true }).count()).toBe(1);
    expect(await summary.textContent()).not.toContain("stored");
    expect(await page.locator("body").textContent()).not.toContain(fakeSecret);
    await screenshot(page, "09-secret-store-answered.png");
  });

  it("keeps a store-bound question interactive after Gateway validation rejects its hosts", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = secretStoreQuestion("question-store-secret-validation");
    const fakeSecret = "fake-secret-never-use-validation-proof-456";
    const validationMessage = "Allowed hosts must be valid hostnames.";
    await gateway.setMethodResponse("question.resolve", {
      __mockError: { code: "INVALID_REQUEST", message: validationMessage },
    });
    await emitRequested(gateway, request);

    const panel = panelFor(page, "Provide the deployment API key");
    const secretInput = panel.locator('input[type="password"]');
    const hostsInput = panel.locator(".chat-question-panel__hosts");
    await secretInput.fill(fakeSecret);
    await hostsInput.fill("bad-host.example.test");
    await panel.getByRole("button", { name: "Submit", exact: true }).click();
    await gateway.waitForRequest("question.resolve");
    await panel.getByText(validationMessage, { exact: false }).waitFor();
    await expect.poll(() => secretInput.isEnabled()).toBe(true);
    expect(await secretInput.inputValue()).toBe(fakeSecret);
    expect(await page.locator("body").textContent()).not.toContain(fakeSecret);
    await screenshot(page, "10-secret-store-validation-error.png");

    await gateway.setMethodResponse("question.resolve", storedSecretAnswer());
    await hostsInput.fill("corrected.example.test");
    const previousRequestCount = (await gateway.getRequests("question.resolve")).length;
    await panel.getByRole("button", { name: "Submit", exact: true }).click();
    const retry = await gateway.waitForRequest("question.resolve", {
      after: previousRequestCount,
    });
    expect(retry.params).toEqual({
      id: request.id,
      answers: { answers: { api_key: [fakeSecret] } },
      secretStoreAllowedHosts: ["corrected.example.test"],
    });
    await expect.poll(() => panel.count()).toBe(0);
    expect(await page.locator("body").textContent()).not.toContain(fakeSecret);
  });

  it("loads a mounted /ask document and resolves its secret through the shared question card", async () => {
    context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const request = secretStoreQuestion("question-store-secret-deep-link");
    const fakeSecret = "fake-secret-never-use-deep-link-proof-789";
    const gateway = await installMockGateway(page, {
      basePath: "/operator",
      featureMethods: ["question.get", "question.resolve"],
      methodResponses: {
        "question.get": { question: request },
        "question.resolve": storedSecretAnswer(),
      },
    });
    const documentUrl = new URL(
      `operator/ask/${encodeURIComponent(request.id)}`,
      suite.server.baseUrl,
    );
    await page.goto(documentUrl.toString());
    const getRequest = await gateway.waitForRequest("question.get");
    expect(getRequest.params).toEqual({ id: request.id });

    const document = page.locator("openclaw-question-page");
    await document.waitFor();
    expect(await page.locator("openclaw-app-shell, openclaw-app-sidebar").count()).toBe(0);
    const panel = document.locator("openclaw-chat-question-panel");
    await panel.waitFor();
    await screenshot(page, "11-secret-store-ask-pending.png");
    const secretInput = panel.locator('input[type="password"]');
    await secretInput.fill(fakeSecret);
    expect(await page.locator("body").textContent()).not.toContain(fakeSecret);
    expect(await page.locator("body").evaluate((element) => element.innerHTML)).not.toContain(
      fakeSecret,
    );
    await screenshot(page, "12-secret-store-ask-masked-input.png");
    await panel.getByRole("button", { name: "Submit", exact: true }).click();

    const resolveRequest = await gateway.waitForRequest("question.resolve");
    expect(resolveRequest.params).toEqual({
      id: request.id,
      answers: { answers: { api_key: [fakeSecret] } },
      secretStoreAllowedHosts: ["api.example.test"],
    });
    await document.getByRole("heading", { name: "Answered", exact: true }).waitFor();
    expect(await document.textContent()).not.toContain(fakeSecret);
    expect(await document.textContent()).not.toContain("stored");
    expect(new URL(page.url()).pathname).toBe(`/operator/ask/${request.id}`);
    await screenshot(page, "13-secret-store-ask-answered.png");
  });

  it("keeps multi-select on one step and submits labels as an array", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = questionRecord("question-release-checks", [
      {
        questionId: "release_checks",
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

    const answers = { answers: { release_checks: ["Tests", "Metrics"] } };
    await gateway.setMethodResponse("question.resolve", {
      status: "answered",
      answers,
    } satisfies QuestionResolveResult);
    await panel.getByRole("button", { name: "Submit", exact: true }).click();
    const resolveRequest = await gateway.waitForRequest("question.resolve");
    expect(resolveRequest.params).toEqual({ id: request.id, answers });
    await expect.poll(() => panel.count()).toBe(0);
  });

  it("restores the composer from an authoritative cancellation without a resolution event", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = questionRecord("question-skip-without-broadcast", [
      {
        questionId: "deploy_target",
        header: "Deploy",
        question: "Should I continue the deployment?",
        options: [{ label: "Staging" }, { label: "Production" }],
      },
    ]);
    await emitRequested(gateway, request);
    const panel = panelFor(page, "Should I continue the deployment?");
    await panel.waitFor();
    await expectQuestionAttention(page, true);
    await gateway.setMethodResponse("question.resolve", {
      status: "cancelled",
    } satisfies QuestionResolveResult);

    await panel.getByRole("button", { name: "Skip", exact: true }).click();
    const resolveRequest = await gateway.waitForRequest("question.resolve");
    expect(resolveRequest.params).toEqual({ id: request.id, cancel: true });
    await expect.poll(() => panel.count()).toBe(0);
    await expectQuestionAttention(page, false);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    await expect
      .poll(() => page.locator(".chat-question-summary").filter({ hasText: "Skipped" }).count())
      .toBe(1);
  });

  it.each([
    { action: "answer", status: "answered" as const, closeSubmittingPane: false },
    { action: "cancellation", status: "cancelled" as const, closeSubmittingPane: false },
    {
      action: "answer after its submitting pane closes",
      status: "answered" as const,
      closeSubmittingPane: true,
    },
    {
      action: "cancellation after its submitting pane closes",
      status: "cancelled" as const,
      closeSubmittingPane: true,
    },
  ])(
    "updates current panes and sidebar from an authoritative $action without a resolution event",
    async ({ status, closeSubmittingPane }) => {
      const { gateway, page } = await openQuestionPage();
      await page.getByRole("button", { name: "Open split view" }).click();
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count()).toBe(2);
      await expect
        .poll(async () => (await gateway.getRequests("question.list")).length)
        .toBeGreaterThanOrEqual(3);

      const request = questionRecord(`question-split-${status}-${closeSubmittingPane}`, [
        {
          questionId: "deploy_target",
          header: "Deploy",
          question: "Where should both panes deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        },
      ]);
      await emitRequested(gateway, request);
      const panels = panelFor(page, "Where should both panes deploy?");
      await expect.poll(() => panels.count()).toBe(2);
      await expectQuestionAttention(page, true);

      const answers = { answers: { deploy_target: ["Staging"] } };
      const result: QuestionResolveResult =
        status === "answered" ? { status, answers } : { status };
      if (closeSubmittingPane) {
        await gateway.deferNext("question.resolve");
      } else {
        await gateway.setMethodResponse("question.resolve", result);
      }
      const submittingIndex = closeSubmittingPane ? 1 : 0;
      const submittingPane = panes.nth(submittingIndex);
      const submittingPanel = panels.nth(submittingIndex);
      if (status === "answered") {
        await submittingPanel.getByRole("radio", { name: /Staging/ }).click();
      }
      await submittingPanel
        .getByRole("button", { name: status === "answered" ? "Submit" : "Skip", exact: true })
        .click();
      const resolveRequest = await gateway.waitForRequest("question.resolve");
      expect(resolveRequest.params).toEqual(
        status === "answered" ? { id: request.id, answers } : { id: request.id, cancel: true },
      );
      expect(await gateway.getRequests("question.resolve")).toHaveLength(1);
      const remainingPanes = page.locator("openclaw-chat-pane");
      if (closeSubmittingPane) {
        await submittingPane.getByRole("button", { name: "Close pane", exact: true }).click();
        await expect.poll(() => remainingPanes.count()).toBe(1);
        await expectQuestionAttention(page, true);
        await gateway.resolveDeferred("question.resolve", result);
      }
      const remainingCount = closeSubmittingPane ? 1 : 2;

      await expect.poll(() => panels.count()).toBe(0);
      await expect
        .poll(() => remainingPanes.locator(".agent-chat__composer-combobox textarea").count())
        .toBe(remainingCount);
      await expect
        .poll(() =>
          page
            .locator(".chat-question-summary")
            .filter({ hasText: status === "answered" ? "Staging" : "Skipped" })
            .count(),
        )
        .toBe(remainingCount);
      await expectQuestionAttention(page, false);
    },
  );

  it("restores the composer when reconnect recovery cannot find an old question", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = questionRecord("question-expired-during-disconnect", [
      {
        questionId: "deploy_target",
        header: "Deploy",
        question: "Where should I deploy after reconnecting?",
        options: [{ label: "Staging" }, { label: "Production" }],
      },
    ]);
    await emitRequested(gateway, request);
    const panel = panelFor(page, "Where should I deploy after reconnecting?");
    await panel.waitFor();
    await expectQuestionAttention(page, true);

    await gateway.deferNext("question.get");
    await gateway.deferNext("question.get");
    await gateway.closeLatest();
    const recovery = await gateway.waitForRequest("question.get");
    expect(recovery.params).toEqual({ id: request.id });
    await expect.poll(async () => (await gateway.getRequests("question.get")).length).toBe(2);
    const notFound = {
      code: "INVALID_REQUEST",
      message: "question was not found",
      details: { reason: "QUESTION_NOT_FOUND" },
    };
    await gateway.rejectDeferred("question.get", notFound);
    await gateway.rejectDeferred("question.get", notFound);

    await expect.poll(() => panel.count()).toBe(0);
    await expectQuestionAttention(page, false);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    expect(await gateway.getRequests("question.get")).toHaveLength(2);
  });

  it("shows a 1/2 stepper with answered and expired summaries", async () => {
    const { gateway, page } = await openQuestionPage();
    const elsewhere = questionRecord("question-external-answer", [
      {
        questionId: "approval_path",
        header: "Approval",
        question: "Who should approve the release?",
        options: [{ label: "Maintainer" }, { label: "Release manager" }],
      },
    ]);
    const expired = questionRecord("question-expired-window", [
      {
        questionId: "release_window",
        header: "Window",
        question: "When should the release start?",
        options: [{ label: "Now" }, { label: "Tomorrow" }],
      },
    ]);

    await emitRequested(gateway, elsewhere);
    await gateway.emitGatewayEvent("question.resolved", {
      id: elsewhere.id,
      status: "answered",
      answers: { answers: { approval_path: ["Release manager"] } },
    });
    await emitRequested(gateway, expired);
    await gateway.emitGatewayEvent("question.resolved", {
      id: expired.id,
      status: "expired",
    });

    const stepper = questionRecord("question-release-plan", [
      {
        questionId: "channel",
        header: "Channel",
        question: "Which release channel should I use?",
        options: [{ label: "Beta" }, { label: "Stable" }],
        isOther: true,
      },
      {
        questionId: "notes",
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
    const expiredSummary = page.locator(".chat-question-summary").filter({ hasText: "Expired" });
    await expect.poll(() => expiredSummary.count()).toBe(1);
    await expiredSummary.scrollIntoViewIfNeeded();
    await screenshot(page, "04-question-terminal-states.png");
  });
});
