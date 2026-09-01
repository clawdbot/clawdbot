// Control UI tests cover workboard behavior.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { WORKBOARD_CHANGED_EVENT } from "../../../../packages/workboard-contract/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard mocked Gateway E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { height: 1000, width: 2400 };
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const linkedSessionKey = "agent:main:workboard-proof";
const linkedSessionName = "Implementation session";
const WORKBOARD_STATUSES: readonly WorkboardStatus[] = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
];

type RecordedPage = {
  context: BrowserContext;
  page: Page;
  rawVideoDir: string;
};

type ProofArtifacts = {
  directory: string;
  screenshots: string[];
  videos: string[];
};

function createProofArtifacts(scope: string): ProofArtifacts {
  return {
    directory: captureUiProofEnabled ? createControlUiE2eArtifactDir(scope) : "",
    screenshots: [],
    videos: [],
  };
}

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workboardField(scope: Page | Locator, label: string) {
  return scope.locator(".workboard-field").filter({
    hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\b`, "u"),
  });
}

async function waitForWorkboardSelectValue(control: Locator, value: string): Promise<void> {
  await expect.poll(() => control.inputValue()).toBe(value);
}

async function chooseWorkboardSelectOption(
  scope: Page | Locator,
  label: string,
  optionLabel: string,
): Promise<void> {
  const field = workboardField(scope, label);
  expect(await field.count()).toBe(1);
  await chooseWorkboardSelectFieldOption(field, optionLabel);
}

async function chooseWorkboardSelectFieldOption(
  field: Locator,
  optionLabel: string,
  control = field.locator("select"),
): Promise<void> {
  const optionValue = await field.locator("option").evaluateAll((options, optionText) => {
    const option = options.find((candidate) =>
      candidate.textContent?.trim().startsWith(optionText),
    );
    return option?.getAttribute("value") ?? null;
  }, optionLabel);
  const value = expectDefined(optionValue, `Workboard option: ${optionLabel}`);
  await control.selectOption(value);
  await waitForWorkboardSelectValue(control, value);
}

async function expectWorkboardSelectTextFits(control: Locator): Promise<void> {
  const geometry = await control.evaluate((select) => {
    const bounds = select.getBoundingClientRect();
    const parent = select.parentElement!.getBoundingClientRect();
    return {
      width: bounds.width,
      available: parent.width,
      overflow: select.scrollWidth - select.clientWidth,
    };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.width).toBeLessThanOrEqual(geometry.available + 1);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
}

async function setWorkboardDraftField(
  scope: Page | Locator,
  label: string,
  value: string,
): Promise<void> {
  const input = scope.getByLabel(label);
  await input.fill(value);
  await expect.poll(() => input.inputValue()).toBe(value);
}

async function waitForRequests(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length >= count) {
      return requests;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
}

async function waitForNextRequest(
  gateway: MockGatewayControls,
  method: string,
  previousCount: number,
): Promise<MockGatewayRequest> {
  const requests = await waitForRequests(gateway, method, previousCount + 1);
  const request = requests.at(-1);
  if (!request) {
    throw new Error(`No ${method} request found`);
  }
  return request;
}

function workboardConfigSnapshot() {
  const config = {
    plugins: {
      entries: {
        workboard: { enabled: true },
      },
    },
  };
  return {
    config,
    hash: "workboard-e2e-config",
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, 2),
    resolved: config,
    sourceConfig: config,
  };
}

function sessionsListResponse(sessions: GatewaySessionRow[]) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions,
    ts: baseTime,
  };
}

function sessionRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    contextTokens: 0,
    displayName: linkedSessionName,
    hasActiveRun: false,
    key: linkedSessionKey,
    kind: "direct",
    label: linkedSessionName,
    model: "gpt-5.5",
    modelProvider: "openai",
    totalTokens: 0,
    updatedAt: baseTime,
    ...overrides,
  };
}

function card(
  overrides: Partial<WorkboardCard> & Pick<WorkboardCard, "id" | "title">,
): WorkboardCard {
  return {
    createdAt: baseTime,
    labels: [],
    notes: "",
    position: 1000,
    priority: "normal",
    status: "todo",
    updatedAt: baseTime,
    ...overrides,
  };
}

function cardsListResponse(
  cards: WorkboardCard[],
  boards: WorkboardBoardSummary[] = [
    { id: "default", total: cards.length, active: cards.length, archived: 0, byStatus: {} },
  ],
) {
  return {
    boards,
    cards,
    statuses: WORKBOARD_STATUSES,
  };
}

function statusColumn(page: Page, status: string) {
  const statusClass = status.trim().toLowerCase().replaceAll(/\s+/gu, "-");
  return page.locator(`.workboard-column--${statusClass}`).first();
}

function cardInColumn(page: Page, status: string, title: string) {
  return statusColumn(page, status).locator(".workboard-card", { hasText: title }).first();
}

async function newRecordedPage(
  artifacts: ProofArtifacts,
  label: string,
  options: { hasTouch?: boolean } = {},
): Promise<RecordedPage> {
  const rawVideoDir = path.join(artifacts.directory, `${label}-raw`);
  if (captureUiProofEnabled) {
    await mkdir(rawVideoDir, { recursive: true });
  }
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await suite.browser.newContext({
      hasTouch: options.hasTouch,
      locale: "en-US",
      recordVideo: captureUiProofEnabled ? { dir: rawVideoDir, size: viewport } : undefined,
      serviceWorkers: "block",
      viewport,
    });
    page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    return { context, page, rawVideoDir };
  } catch (error) {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    throw error;
  }
}

async function captureScreenshot(
  page: Page,
  artifacts: ProofArtifacts,
  name: string,
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const screenshotPath = path.join(artifacts.directory, `${name}.png`);
  await page.screenshot({ fullPage: true, path: screenshotPath });
  artifacts.screenshots.push(screenshotPath);
}

async function closeRecordedPage(
  recorded: RecordedPage,
  artifacts: ProofArtifacts,
  label: string,
): Promise<void> {
  const video = recorded.page.video();
  await recorded.context.close();
  if (!video) {
    return;
  }
  const rawVideoPath = await video.path();
  const videoPath = path.join(artifacts.directory, `${label}.webm`);
  await copyFile(rawVideoPath, videoPath);
  artifacts.videos.push(videoPath);
  // Preserve the raw recording if close or copy fails; only remove the retained copy's source.
  await rm(recorded.rawVideoDir, { force: true, recursive: true });
}

suite.define(() => {
  it("persists Workboard create, edit, running move, lifecycle sync, reload, and read-only state", async () => {
    const artifacts = createProofArtifacts("workboard-lifecycle");
    const createdCard = card({
      id: "card-1",
      labels: ["ui", "proof"],
      notes: "Acceptance: browser proof",
      sessionKey: linkedSessionKey,
      title: "Draft Workboard browser proof",
      updatedAt: baseTime + 1,
    });
    const editedCard = card({
      ...createdCard,
      labels: ["ui", "proof", "e2e"],
      notes: "Acceptance: mocked Gateway browser proof\nProof: pending",
      priority: "high",
      title: "Workboard browser proof",
      updatedAt: baseTime + 2,
    });
    const runningCard = card({
      ...editedCard,
      status: "running",
      updatedAt: baseTime + 3,
    });
    const reviewedCard = card({
      ...runningCard,
      events: [
        {
          at: baseTime + 4,
          fromStatus: "running",
          id: "event-review",
          kind: "moved",
          toStatus: "review",
        },
      ],
      status: "review",
      updatedAt: baseTime + 4,
    });
    const liveRefreshedCard = card({
      ...reviewedCard,
      notes: "Acceptance: live Gateway invalidation refreshed this card",
      updatedAt: baseTime + 5,
    });

    const writable = await newRecordedPage(artifacts, "workboard-writable");
    await writable.page.clock.install();
    try {
      const writableGateway = await installMockGateway(writable.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([sessionRow()]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([]),
        },
      });
      const response = await writable.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await statusColumn(writable.page, "Todo").waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "01-empty-board");

      const prioritySelect = writable.page.getByRole("combobox", { name: "All priorities" });
      const directRoutePickerStyles = await prioritySelect.evaluate((select) => {
        const styles = getComputedStyle(select);
        return {
          minHeight: styles.minHeight,
          paddingRight: styles.paddingRight,
        };
      });
      expect(directRoutePickerStyles).toEqual({
        minHeight: "36px",
        paddingRight: "36px",
      });
      await prioritySelect.selectOption("urgent");
      await waitForWorkboardSelectValue(prioritySelect, "urgent");
      await prioritySelect.selectOption("high");
      await waitForWorkboardSelectValue(prioritySelect, "high");
      await prioritySelect.selectOption("all");
      await waitForWorkboardSelectValue(prioritySelect, "all");

      await writableGateway.deferNext("workboard.cards.create");
      await writable.page
        .locator(".workboard-toolbar__actions")
        .getByRole("button", { name: /New card/u })
        .click();
      const createDialog = writable.page.getByRole("dialog", { name: "New card" });
      const createForm = writable.page.locator(".workboard-draft");
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await setWorkboardDraftField(createForm, "Title", createdCard.title);
      await setWorkboardDraftField(createForm, "Notes", createdCard.notes ?? "");
      await chooseWorkboardSelectOption(createForm, "Session", linkedSessionName);
      await setWorkboardDraftField(createForm, "Labels", "ui, proof");
      await captureScreenshot(writable.page, artifacts, "02-create-dialog");
      const createBefore = (await writableGateway.getRequests("workboard.cards.create")).length;
      await createForm.getByRole("button", { name: /^Create$/u }).click();
      const createRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.create",
        createBefore,
      );
      expect(requestParams(createRequest)).toMatchObject({
        labels: ["ui", "proof"],
        notes: createdCard.notes,
        sessionKey: linkedSessionKey,
        status: "todo",
        title: createdCard.title,
      });
      expect(await createForm.getByLabel("Title").isDisabled()).toBe(true);
      expect(await createForm.getByLabel("Notes").isDisabled()).toBe(true);
      expect(await createForm.getByLabel("Labels").isDisabled()).toBe(true);
      expect(
        await createForm
          .getByRole("combobox")
          .evaluateAll(
            (inputs) => inputs.filter((input) => (input as HTMLInputElement).disabled).length,
          ),
      ).toBe(3);
      expect(
        await createForm.locator(".workboard-agent-select .agent-select__trigger").isDisabled(),
      ).toBe(true);
      const pendingCancelButtons = createForm.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      expect(await pendingCancelButtons.count()).toBe(2);
      expect(await pendingCancelButtons.first().isDisabled()).toBe(true);
      expect(await pendingCancelButtons.last().isDisabled()).toBe(true);
      expect(await createForm.locator(".workboard-template-strip button:disabled").count()).toBe(5);
      await writable.page.keyboard.press("Escape");
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await createDialog.click({ position: { x: 4, y: 4 } });
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await writableGateway.resolveDeferred("workboard.cards.create", { card: createdCard });
      await cardInColumn(writable.page, "Todo", createdCard.title).waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "03-created-card");

      await writableGateway.deferNext("workboard.cards.update");
      await cardInColumn(writable.page, "Todo", createdCard.title)
        .locator('button[aria-label="Edit card"]')
        .click();
      const editDialog = writable.page.getByRole("dialog", { name: "Edit card" });
      const editForm = writable.page.locator(".workboard-draft");
      await expect.poll(() => editDialog.isVisible()).toBe(true);
      await setWorkboardDraftField(editForm, "Title", editedCard.title);
      await setWorkboardDraftField(editForm, "Notes", editedCard.notes ?? "");
      await chooseWorkboardSelectOption(editForm, "Priority", "High");
      await setWorkboardDraftField(editForm, "Labels", "ui, proof, e2e");
      const updateBeforeEdit = (await writableGateway.getRequests("workboard.cards.update")).length;
      await editForm.getByRole("button", { name: /^Save$/u }).click();
      const editRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.update",
        updateBeforeEdit,
      );
      expect(requestParams(editRequest)).toEqual({
        id: createdCard.id,
        expectedUpdatedAt: createdCard.updatedAt,
        patch: {
          labels: ["ui", "proof", "e2e"],
          notes: editedCard.notes,
          priority: "high",
          title: editedCard.title,
        },
      });
      await writableGateway.resolveDeferred("workboard.cards.update", { card: editedCard });
      await cardInColumn(writable.page, "Todo", editedCard.title).waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "04-edited-card");

      await cardInColumn(writable.page, "Todo", editedCard.title).click();
      const details = writable.page.locator(".workboard-detail");
      await details.getByText(editedCard.title).waitFor({ state: "visible" });
      await details.getByText("Acceptance: mocked Gateway browser proof").waitFor({
        state: "visible",
      });
      await details.locator(".workboard-card__move-select").waitFor({ state: "visible" });
      expect(await details.getByRole("button", { name: "Open session" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Edit card" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Archive card" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Delete card" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Stop session" }).count()).toBe(0);
      await captureScreenshot(writable.page, artifacts, "05-detail-actions");
      await details.locator('button[aria-label="Cancel"]').click();

      await writableGateway.deferNext("workboard.cards.move");
      const dragSource = cardInColumn(writable.page, "Todo", editedCard.title);
      await dragSource.dispatchEvent("dragstart");
      await expect
        .poll(() => dragSource.getAttribute("class"))
        .toContain("workboard-card--dragging");
      await expect
        .poll(() => dragSource.evaluate((element) => window.getComputedStyle(element).opacity))
        .toBe("0.45");
      expect(await writable.page.locator(".workboard-column--drop").count()).toBe(9);
      await captureScreenshot(writable.page, artifacts, "06-drag-feedback");
      await dragSource.dispatchEvent("dragend");
      await expect
        .poll(() => dragSource.getAttribute("class"))
        .not.toContain("workboard-card--dragging");

      const moveBefore = (await writableGateway.getRequests("workboard.cards.move")).length;
      await dragSource.dragTo(statusColumn(writable.page, "Running"));
      const moveRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.move",
        moveBefore,
      );
      expect(requestParams(moveRequest)).toMatchObject({
        id: editedCard.id,
        status: "running",
      });
      await writableGateway.resolveDeferred("workboard.cards.move", { card: runningCard });
      await cardInColumn(writable.page, "Running", editedCard.title).waitFor({
        state: "visible",
      });
      await captureScreenshot(writable.page, artifacts, "07-moved-running");

      const updateBeforeLifecycle = (await writableGateway.getRequests("workboard.cards.update"))
        .length;
      const sessionListBeforeSync = (await writableGateway.getRequests("sessions.list")).length;
      await writableGateway.deferNext("sessions.list");
      await writableGateway.emitGatewayEvent("sessions.changed", {
        ...sessionRow({
          hasActiveRun: false,
          status: "done",
          updatedAt: baseTime + 4,
        }),
        reason: "lifecycle",
        sessionKey: linkedSessionKey,
        ts: baseTime + 4,
      });
      await waitForNextRequest(writableGateway, "sessions.list", sessionListBeforeSync);
      await writableGateway.resolveDeferred(
        "sessions.list",
        sessionsListResponse([
          sessionRow({ hasActiveRun: false, status: "done", updatedAt: baseTime + 4 }),
        ]),
      );
      await writable.page.waitForTimeout(250);
      expect(await writableGateway.getRequests("workboard.cards.update")).toHaveLength(
        updateBeforeLifecycle,
      );

      const listBeforeLifecycle = (await writableGateway.getRequests("workboard.cards.list"))
        .length;
      await writableGateway.deferNext("workboard.cards.list");
      await writableGateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
        epoch: "workboard-e2e",
        revision: 1,
      });
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeLifecycle);
      await writableGateway.resolveDeferred(
        "workboard.cards.list",
        cardsListResponse([reviewedCard]),
      );
      const reviewedCardSurface = cardInColumn(writable.page, "Review", editedCard.title);
      await reviewedCardSurface.waitFor({ state: "visible" });
      await reviewedCardSurface.getByRole("button", { name: "View details", exact: true }).click();
      await writable.page.locator(".workboard-detail").getByText("Moved to Review").waitFor({
        state: "visible",
      });
      await captureScreenshot(writable.page, artifacts, "08-lifecycle-review");
      await details.locator('button[aria-label="Cancel"]').click();
      await details.waitFor({ state: "hidden" });

      await cardInColumn(writable.page, "Review", editedCard.title)
        .locator('button[aria-label="Edit card"]')
        .click();
      await expect.poll(() => editDialog.isVisible()).toBe(true);
      const listBeforeLiveRefresh = (await writableGateway.getRequests("workboard.cards.list"))
        .length;
      await writableGateway.deferNext("workboard.cards.list");
      await writableGateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
        epoch: "workboard-e2e",
        revision: 2,
      });
      await writable.page.waitForTimeout(250);
      expect(await writableGateway.getRequests("workboard.cards.list")).toHaveLength(
        listBeforeLiveRefresh,
      );
      await editForm
        .locator(":scope > .workboard-modal__actions")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeLiveRefresh);
      await writableGateway.resolveDeferred("workboard.cards.list", {
        cards: [liveRefreshedCard],
        statuses: WORKBOARD_STATUSES,
      });
      await writable.page
        .getByText("Acceptance: live Gateway invalidation refreshed this card")
        .waitFor({ state: "visible" });
      const listAfterLiveRefresh = (await writableGateway.getRequests("workboard.cards.list"))
        .length;
      await writable.page.clock.fastForward(1_250);
      expect(await writableGateway.getRequests("workboard.cards.list")).toHaveLength(
        listAfterLiveRefresh,
      );

      await writableGateway.deferNext("workboard.cards.list");
      const listBeforeReload = (await writableGateway.getRequests("workboard.cards.list")).length;
      await writable.page
        .locator(".workboard-toolbar__actions")
        .getByRole("button", { name: /^Refresh$/u })
        .click();
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeReload);
      await writableGateway.resolveDeferred("workboard.cards.list", {
        cards: [liveRefreshedCard],
        statuses: WORKBOARD_STATUSES,
      });
      await cardInColumn(writable.page, "Review", editedCard.title).waitFor({ state: "visible" });
      await writable.page
        .getByText("Acceptance: live Gateway invalidation refreshed this card")
        .waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "09-reloaded-review");
    } finally {
      await closeRecordedPage(writable, artifacts, "workboard-writable");
    }

    const readOnly = await newRecordedPage(artifacts, "workboard-read-only");
    try {
      const readOnlyGateway = await installMockGateway(readOnly.page, {
        ...workboardUi,
        operatorScopes: ["operator.read"],
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([
            sessionRow({ hasActiveRun: false, status: "done", updatedAt: baseTime + 4 }),
          ]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([runningCard]),
        },
      });
      const response = await readOnly.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await cardInColumn(readOnly.page, "Running", editedCard.title).waitFor({
        state: "visible",
      });
      await captureScreenshot(readOnly.page, artifacts, "09-read-only-board");
      expect(await readOnly.page.getByRole("button", { name: /New card/u }).count()).toBe(0);
      expect(await readOnly.page.locator('button[aria-label="Edit card"]').count()).toBe(0);
      expect(await readOnly.page.locator('button[aria-label="Delete card"]').count()).toBe(0);
      expect(await readOnly.page.locator('button[aria-label="Run default agent"]').count()).toBe(0);
      expect(
        await cardInColumn(readOnly.page, "Running", editedCard.title).getAttribute("draggable"),
      ).toBe("false");

      await cardInColumn(readOnly.page, "Running", editedCard.title).click();
      await readOnly.page.locator(".workboard-detail").getByText(editedCard.title).waitFor({
        state: "visible",
      });
      const readOnlyDetail = readOnly.page.locator(".workboard-detail");
      expect(await readOnlyDetail.locator(".workboard-card__move-select").count()).toBe(0);
      expect(await readOnlyDetail.getByRole("button", { name: "Edit card" }).count()).toBe(0);
      expect(await readOnlyDetail.getByRole("button", { name: "Archive card" }).count()).toBe(0);
      expect(await readOnlyDetail.getByRole("button", { name: "Delete card" }).count()).toBe(0);
      expect(await readOnly.page.locator(".workboard-detail__note").count()).toBe(0);
      expect(await readOnly.page.getByRole("button", { name: /Add note/u }).count()).toBe(0);
      expect(await readOnlyGateway.getRequests("workboard.cards.update")).toHaveLength(0);
      expect(await readOnlyGateway.getRequests("workboard.cards.move")).toHaveLength(0);
      expect(await readOnlyGateway.getRequests("workboard.cards.create")).toHaveLength(0);
    } finally {
      await closeRecordedPage(readOnly, artifacts, "workboard-read-only");
    }

    if (captureUiProofEnabled) {
      await writeFile(
        path.join(artifacts.directory, "manifest.json"),
        `${JSON.stringify(artifacts, null, 2)}\n`,
        "utf-8",
      );
    }
  });

  it("keeps card titles visible when a column overflows its height", async () => {
    const artifacts = createProofArtifacts("workboard-overflow");
    const crowdedColumnCardCount = 8;
    const overflowTitle = (index: number) =>
      `Overflowing backlog card ${index + 1} with a long title that wraps onto two lines`;
    const crowdedCards = Array.from({ length: crowdedColumnCardCount }, (_, index) =>
      card({
        id: `overflow-card-${index + 1}`,
        notes: "Acceptance: title stays visible while the column scrolls.",
        position: 1000 + index,
        status: "todo",
        title: overflowTitle(index),
        updatedAt: baseTime + index,
      }),
    );

    const recorded = await newRecordedPage(artifacts, "workboard-overflow");
    try {
      await installMockGateway(recorded.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([sessionRow()]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse(crowdedCards),
        },
      });
      // Constrain the height so the Todo column must overflow its visible area.
      await recorded.page.setViewportSize({ height: 720, width: 1400 });
      const response = await recorded.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      const column = statusColumn(recorded.page, "Todo");
      await column.waitFor({ state: "visible" });
      await cardInColumn(recorded.page, "Todo", overflowTitle(0)).waitFor({ state: "visible" });
      await captureScreenshot(recorded.page, artifacts, "09-overflow-column");

      const titleHeights = await column
        .locator(".workboard-card h3")
        .evaluateAll((titles) => titles.map((title) => title.getBoundingClientRect().height));
      expect(titleHeights).toHaveLength(crowdedColumnCardCount);
      for (const height of titleHeights) {
        // Squeezed implicit grid rows previously collapsed the line-clamped title to 0px.
        expect(height).toBeGreaterThan(0);
      }

      const columnScrolls = await column
        .locator(".workboard-column__cards")
        .evaluate((cards) => cards.scrollHeight > cards.clientHeight + 1);
      expect(columnScrolls).toBe(true);
    } finally {
      await closeRecordedPage(recorded, artifacts, "workboard-overflow");
    }
  });

  it("collapses empty stages into rails without squeezing active columns", async () => {
    const artifacts = createProofArtifacts("workboard-collapsed-columns");
    const reviewCard = card({
      id: "review-card",
      status: "review",
      title: "Review the completed implementation",
    });
    const doneCard = card({
      id: "done-card",
      status: "done",
      title: "Previously completed work",
    });
    const recorded = await newRecordedPage(artifacts, "workboard-collapsed-columns");
    try {
      const gateway = await installMockGateway(recorded.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([reviewCard, doneCard]),
          "workboard.cards.move": { card: { ...reviewCard, status: "ready" } },
        },
      });
      await recorded.page.setViewportSize({ height: 760, width: 1200 });
      const response = await recorded.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await recorded.page.locator(".workboard-column--review .workboard-card").waitFor();

      const collapsedColumns = recorded.page.locator(".workboard-column--collapsed");
      await expect.poll(() => collapsedColumns.count()).toBe(0);
      const emptyColumns = recorded.page.locator(".workboard-select--empty-columns");
      await expectWorkboardSelectTextFits(emptyColumns);
      await chooseWorkboardSelectFieldOption(emptyColumns, "Hide empty", emptyColumns);
      await expect.poll(() => recorded.page.locator(".workboard-column").count()).toBe(2);
      await chooseWorkboardSelectFieldOption(emptyColumns, "Show all", emptyColumns);
      await expect.poll(() => recorded.page.locator(".workboard-column").count()).toBe(9);
      await chooseWorkboardSelectFieldOption(emptyColumns, "Collapse empty", emptyColumns);
      await expect.poll(() => collapsedColumns.count()).toBe(7);
      const collapsedWidth = await recorded.page
        .locator(".workboard-column--ready")
        .evaluate((column) => column.getBoundingClientRect().width);
      const reviewWidth = await recorded.page
        .locator(".workboard-column--review")
        .evaluate((column) => column.getBoundingClientRect().width);
      expect(collapsedWidth).toBeGreaterThanOrEqual(44);
      expect(collapsedWidth).toBeLessThanOrEqual(52);
      expect(reviewWidth).toBeGreaterThanOrEqual(262);

      const readyRail = recorded.page.locator(".workboard-column--ready .workboard-column__rail");
      const collapsedRailStyle = await readyRail.evaluate((rail) => ({
        boxShadow: getComputedStyle(rail).boxShadow,
        hasExpandIcons: rail.querySelectorAll('[class*="direction-icon--expand-"]').length === 2,
      }));
      expect(collapsedRailStyle.boxShadow).not.toBe("none");
      expect(collapsedRailStyle.hasExpandIcons).toBe(true);

      const reviewHeader = recorded.page.locator(
        ".workboard-column--review .workboard-column__header",
      );
      const collapseButton = reviewHeader.getByRole("button", { name: "Collapse Review column" });
      expect(await collapseButton.evaluate((button) => getComputedStyle(button).opacity)).toBe("0");
      expect(await collapseButton.locator('[class*="direction-icon--collapse-"]').count()).toBe(2);
      await collapseButton.focus();
      await expect
        .poll(() => collapseButton.evaluate((button) => getComputedStyle(button).opacity))
        .toBe("1");
      await collapseButton.blur();
      await expect
        .poll(() => collapseButton.evaluate((button) => getComputedStyle(button).opacity))
        .toBe("0");
      await reviewHeader.hover();
      await expect
        .poll(() => collapseButton.evaluate((button) => getComputedStyle(button).opacity))
        .toBe("1");

      await recorded.page.emulateMedia({ reducedMotion: "reduce" });
      const reducedMotionTransitions = await recorded.page.evaluate(() => ({
        collapse: getComputedStyle(
          document.querySelector(".workboard-column__collapse") as HTMLElement,
        ).transitionDuration,
        rail: getComputedStyle(
          document.querySelector(".workboard-column__rail-icon") as HTMLElement,
        ).transitionDuration,
      }));
      expect(reducedMotionTransitions).toEqual({ collapse: "0s", rail: "0s" });
      await recorded.page.emulateMedia({ reducedMotion: "no-preference" });

      await captureScreenshot(recorded.page, artifacts, "10-collapsed-columns-desktop");

      await recorded.page.getByRole("button", { name: "Expand Ready column" }).click();
      await expect
        .poll(() => recorded.page.locator(".workboard-column--ready").getAttribute("class"))
        .not.toContain("workboard-column--collapsed");
      const expandedWidth = await recorded.page
        .locator(".workboard-column--ready")
        .evaluate((column) => column.getBoundingClientRect().width);
      expect(expandedWidth).toBeGreaterThanOrEqual(262);
      await recorded.page.getByRole("button", { name: "Collapse Ready column" }).click();

      const viewPreset = recorded.page.locator(".workboard-select--toolbar").first();
      await chooseWorkboardSelectFieldOption(viewPreset, "Review", viewPreset);
      const singleColumnBoard = recorded.page.locator(
        ".workboard-board--page.workboard-board--single-column",
      );
      const singleColumnGeometry = await singleColumnBoard.evaluate((board) => {
        const column = board.querySelector(".workboard-column") as HTMLElement;
        return {
          boardWidth: board.getBoundingClientRect().width,
          columnWidth: column.getBoundingClientRect().width,
        };
      });
      expect(singleColumnGeometry.columnWidth).toBeGreaterThanOrEqual(
        singleColumnGeometry.boardWidth * 0.45,
      );
      expect(singleColumnGeometry.columnWidth).toBeLessThanOrEqual(680);
      await chooseWorkboardSelectFieldOption(viewPreset, "All cards", viewPreset);

      const moveCount = (await gateway.getRequests("workboard.cards.move")).length;
      await recorded.page
        .locator(".workboard-column--review .workboard-card")
        .dragTo(recorded.page.locator(".workboard-column--ready .workboard-column__rail"));
      const moveRequest = await waitForNextRequest(gateway, "workboard.cards.move", moveCount);
      expect(requestParams(moveRequest)).toMatchObject({ id: reviewCard.id, status: "ready" });

      await recorded.page.setViewportSize({ height: 760, width: 700 });
      await expectWorkboardSelectTextFits(emptyColumns);
      const backlogRail = recorded.page.locator(".workboard-column--backlog");
      const mobileLayout = await backlogRail.evaluate((column) => ({
        railWritingMode: getComputedStyle(
          column.querySelector(".workboard-column__rail") as HTMLElement,
        ).writingMode,
        width: column.getBoundingClientRect().width,
      }));
      expect(mobileLayout.railWritingMode).toBe("horizontal-tb");
      expect(mobileLayout.width).toBeGreaterThan(250);
      await captureScreenshot(recorded.page, artifacts, "11-collapsed-columns-mobile");
    } finally {
      await closeRecordedPage(recorded, artifacts, "workboard-collapsed-columns");
    }
  });

  it("keeps touch collapse controls visible and at least 44px", async () => {
    await suite.withPage({ hasTouch: true }, async ({ page }) => {
      await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([
            card({ id: "touch-review-card", status: "review", title: "Review on touch" }),
          ]),
        },
      });
      await page.setViewportSize({ height: 844, width: 390 });
      const response = await page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);

      const collapseButton = page.getByRole("button", { name: "Collapse Review column" });
      await collapseButton.waitFor({ state: "visible" });
      const touchGeometry = await collapseButton.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return {
          height: bounds.height,
          opacity: getComputedStyle(button).opacity,
          width: bounds.width,
        };
      });
      expect(touchGeometry.opacity).toBe("1");
      expect(touchGeometry.width).toBeGreaterThanOrEqual(44);
      expect(touchGeometry.height).toBeGreaterThanOrEqual(44);
    });
  });

  it("filters persisted boards and keeps the selection in the URL", async () => {
    const artifacts = createProofArtifacts("workboard-board-filter");
    const defaultCard = card({ id: "default-card", title: "Default board work" });
    const opsCard = card({
      id: "ops-card",
      title: "Operations board work",
      metadata: { automation: { boardId: "ops" } },
    });
    const boards: WorkboardBoardSummary[] = [
      { id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } },
      {
        id: "ops",
        name: "Operations",
        total: 1,
        active: 1,
        archived: 0,
        byStatus: { todo: 1 },
      },
      {
        id: "archive",
        name: "Old work",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        archivedAt: baseTime,
      },
    ];
    const recorded = await newRecordedPage(artifacts, "workboard-board-filter");
    try {
      await installMockGateway(recorded.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.boards.list": { boards },
          "workboard.cards.list": cardsListResponse([defaultCard, opsCard], boards),
        },
      });

      const response = await recorded.page.goto(
        `${suite.server.baseUrl}workboard?board=ops&agent=main`,
      );
      expect(response?.status()).toBe(200);
      await cardInColumn(recorded.page, "Todo", opsCard.title).waitFor({ state: "visible" });
      await expect.poll(() => new URL(recorded.page.url()).pathname).toBe("/workboard/ops");
      await expect.poll(() => recorded.page.getByText(defaultCard.title).count()).toBe(0);
      expect(new URL(recorded.page.url()).searchParams.has("board")).toBe(false);

      const historyBeforeFilter = await recorded.page.evaluate(() => history.length);
      const boardFilter = recorded.page.locator(".workboard-select--toolbar-board");
      await chooseWorkboardSelectFieldOption(boardFilter, "All boards", boardFilter);
      await cardInColumn(recorded.page, "Todo", defaultCard.title).waitFor({ state: "visible" });
      await expect.poll(() => new URL(recorded.page.url()).pathname).toBe("/workboard");
      expect(new URL(recorded.page.url()).searchParams.has("board")).toBe(false);
      expect(new URL(recorded.page.url()).search).toBe("?agent=main");

      await chooseWorkboardSelectFieldOption(boardFilter, "Operations (ops)", boardFilter);
      await expect.poll(() => new URL(recorded.page.url()).pathname).toBe("/workboard/ops");
      expect(new URL(recorded.page.url()).search).toBe("?agent=main");
      expect(await recorded.page.evaluate(() => history.length)).toBe(historyBeforeFilter);
      expect(await recorded.page.getByText(defaultCard.title).count()).toBe(0);
      expect(await recorded.page.getByText("Old work (archive)").count()).toBeGreaterThan(0);
      await captureScreenshot(recorded.page, artifacts, "10-board-filter-ops");
    } finally {
      await closeRecordedPage(recorded, artifacts, "workboard-board-filter");
    }
  });
});
