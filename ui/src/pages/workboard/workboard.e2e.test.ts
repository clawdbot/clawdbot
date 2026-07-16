// Control UI tests cover workboard behavior.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { WORKBOARD_CHANGED_EVENT } from "../../../../packages/workboard-contract/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardStatus,
} from "../../lib/workboard/index.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/workboard");
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

let server: ControlUiE2eServer;
let browser: Browser;

type RecordedPage = {
  context: BrowserContext;
  page: Page;
  rawVideoDir: string;
};

type ProofArtifacts = {
  screenshots: string[];
  videos: string[];
};

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

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
  control = field.locator("wa-select"),
): Promise<void> {
  const optionValue = await field.locator("wa-option").evaluateAll((options, optionText) => {
    const option = options.find(
      (candidate) => (candidate as HTMLElement & { label?: string }).label === optionText,
    );
    return option?.getAttribute("value") ?? null;
  }, optionLabel);
  expect(optionValue).not.toBeNull();
  await control.evaluate((select, value) => {
    (select as HTMLElement & { value: string }).value = String(value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, optionValue);
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

function readOnlyConnectResponse() {
  return {
    auth: {
      deviceToken: "e2e-read-only-device-token",
      role: "operator",
      scopes: ["operator.read"],
    },
    features: { events: [], methods: ["chat.startup"] },
    protocol: PROTOCOL_VERSION,
    server: { connId: "control-ui-e2e-read-only", version: "e2e" },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "agent",
      },
    },
    type: "hello-ok",
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
  return page
    .locator(".workboard-column")
    .filter({
      has: page.locator(".workboard-column__header h2", {
        hasText: new RegExp(`^${status}$`, "u"),
      }),
    })
    .first();
}

function cardInColumn(page: Page, status: string, title: string) {
  return statusColumn(page, status).locator(".workboard-card", { hasText: title }).first();
}

async function newRecordedPage(label: string): Promise<RecordedPage> {
  await mkdir(artifactDir, { recursive: true });
  const rawVideoDir = path.join(artifactDir, `${label}-raw`);
  await rm(rawVideoDir, { force: true, recursive: true });
  await mkdir(rawVideoDir, { recursive: true });
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await browser.newContext({
      locale: "en-US",
      recordVideo: {
        dir: rawVideoDir,
        size: viewport,
      },
      serviceWorkers: "block",
      viewport,
    });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return { context, page, rawVideoDir };
  } catch (error) {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await rm(rawVideoDir, { force: true, recursive: true });
    throw error;
  }
}

async function captureScreenshot(
  page: Page,
  artifacts: ProofArtifacts,
  name: string,
): Promise<void> {
  const screenshotPath = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ fullPage: true, path: screenshotPath });
  artifacts.screenshots.push(screenshotPath);
}

async function closeRecordedPage(
  recorded: RecordedPage,
  artifacts: ProofArtifacts,
  label: string,
): Promise<void> {
  const video = recorded.page.video();
  try {
    await recorded.context.close();
    if (!video) {
      return;
    }
    const rawVideoPath = await video.path();
    const videoPath = path.join(artifactDir, `${label}.webm`);
    await copyFile(rawVideoPath, videoPath);
    artifacts.videos.push(videoPath);
  } finally {
    await rm(recorded.rawVideoDir, { force: true, recursive: true });
  }
}

describeControlUiE2e("Control UI Workboard mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("persists Workboard create, edit, running move, lifecycle sync, reload, and read-only state", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    const artifacts: ProofArtifacts = { screenshots: [], videos: [] };
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

    const writable = await newRecordedPage("workboard-writable");
    await writable.page.clock.install();
    try {
      const writableGateway = await installMockGateway(writable.page, {
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([sessionRow()]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([]),
        },
      });
      const response = await writable.page.goto(`${server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await statusColumn(writable.page, "Todo").waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "01-empty-board");

      const prioritySelect = writable.page
        .locator(".workboard-toolbar__filters .workboard-select")
        .nth(1);
      const priorityCombobox = prioritySelect.getByRole("combobox");
      await priorityCombobox.focus();
      await writable.page.keyboard.press("ArrowDown");
      await expect.poll(() => priorityCombobox.getAttribute("aria-expanded")).toBe("true");

      await writable.page.keyboard.press("End");
      await writable.page.keyboard.press("Enter");
      await expect
        .poll(() =>
          prioritySelect.evaluate(
            (select) => (select as HTMLElement & { value?: string }).value ?? "",
          ),
        )
        .toBe("urgent");
      await expect.poll(() => priorityCombobox.getAttribute("aria-expanded")).toBe("false");

      await priorityCombobox.focus();
      await writable.page.keyboard.press("ArrowDown");
      await writable.page.keyboard.press("ArrowUp");
      await writable.page.keyboard.press("Enter");
      await expect
        .poll(() =>
          prioritySelect.evaluate(
            (select) => (select as HTMLElement & { value?: string }).value ?? "",
          ),
        )
        .toBe("high");

      await priorityCombobox.focus();
      await writable.page.keyboard.press("ArrowDown");
      await writable.page.keyboard.press("Home");
      await writable.page.keyboard.press("Enter");
      await expect
        .poll(() =>
          prioritySelect.evaluate(
            (select) => (select as HTMLElement & { value?: string }).value ?? "",
          ),
        )
        .toBe("all");
      await expect.poll(() => priorityCombobox.getAttribute("aria-expanded")).toBe("false");

      await writableGateway.deferNext("workboard.cards.create");
      await writable.page
        .locator(".workboard-toolbar__actions")
        .getByRole("button", { name: /New card/u })
        .click();
      const createDialog = writable.page.getByRole("dialog", { name: "New card" });
      const createForm = writable.page.locator('openclaw-modal-dialog[label="New card"]');
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await createForm.getByLabel("Title").fill(createdCard.title);
      await createForm.getByLabel("Notes").fill(createdCard.notes ?? "");
      await chooseWorkboardSelectOption(createForm, "Session", linkedSessionName);
      await createForm.getByLabel("Labels").fill("ui, proof");
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
      ).toBe(4);
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
      const editForm = writable.page.locator('openclaw-modal-dialog[label="Edit card"]');
      await expect.poll(() => editDialog.isVisible()).toBe(true);
      await editForm.getByLabel("Title").fill(editedCard.title);
      await editForm.getByLabel("Notes").fill(editedCard.notes ?? "");
      await chooseWorkboardSelectOption(editForm, "Priority", "High");
      await editForm.getByLabel("Labels").fill("ui, proof, e2e");
      const updateBeforeEdit = (await writableGateway.getRequests("workboard.cards.update")).length;
      await editForm.getByRole("button", { name: /^Save$/u }).click();
      const editRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.update",
        updateBeforeEdit,
      );
      expect(requestParams(editRequest)).toMatchObject({ id: createdCard.id });
      expect(requireRecord(requestParams(editRequest).patch)).toMatchObject({
        labels: ["ui", "proof", "e2e"],
        notes: editedCard.notes,
        priority: "high",
        sessionKey: linkedSessionKey,
        title: editedCard.title,
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
      await dragSource.dragTo(
        statusColumn(writable.page, "Running").locator(".workboard-column__cards"),
      );
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

      await writableGateway.deferNext("workboard.cards.update");
      const syncBefore = (await writableGateway.getRequests("workboard.cards.update")).length;
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
      const syncRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.update",
        syncBefore,
      );
      expect(requestParams(syncRequest)).toMatchObject({ id: runningCard.id });
      expect(requireRecord(requestParams(syncRequest).patch)).toMatchObject({
        metadata: { lifecycleStatusSourceUpdatedAt: baseTime + 4 },
        status: "review",
      });
      await writableGateway.resolveDeferred("workboard.cards.update", { card: reviewedCard });
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
        revision: 1,
      });
      await writable.page.waitForTimeout(250);
      expect(await writableGateway.getRequests("workboard.cards.list")).toHaveLength(
        listBeforeLiveRefresh,
      );
      await editForm
        .locator("form > .workboard-modal__actions")
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

    const readOnly = await newRecordedPage("workboard-read-only");
    try {
      const readOnlyGateway = await installMockGateway(readOnly.page, {
        methodResponses: {
          connect: readOnlyConnectResponse(),
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([
            sessionRow({ hasActiveRun: false, status: "done", updatedAt: baseTime + 4 }),
          ]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([runningCard]),
        },
      });
      const response = await readOnly.page.goto(`${server.baseUrl}workboard`);
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

    await writeFile(
      path.join(artifactDir, "manifest.json"),
      `${JSON.stringify(artifacts, null, 2)}\n`,
      "utf-8",
    );
  });

  it("keeps card titles visible when a column overflows its height", async () => {
    const artifacts: ProofArtifacts = { screenshots: [], videos: [] };
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

    const recorded = await newRecordedPage("workboard-overflow");
    try {
      await installMockGateway(recorded.page, {
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([sessionRow()]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse(crowdedCards),
        },
      });
      // Constrain the height so the Todo column must overflow its visible area.
      await recorded.page.setViewportSize({ height: 720, width: 1400 });
      const response = await recorded.page.goto(`${server.baseUrl}workboard`);
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

  it("filters persisted boards and keeps the selection in the URL", async () => {
    const artifacts: ProofArtifacts = { screenshots: [], videos: [] };
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
    const recorded = await newRecordedPage("workboard-board-filter");
    try {
      await installMockGateway(recorded.page, {
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([defaultCard, opsCard], boards),
        },
      });

      const response = await recorded.page.goto(`${server.baseUrl}workboard?board=ops`);
      expect(response?.status()).toBe(200);
      await cardInColumn(recorded.page, "Todo", opsCard.title).waitFor({ state: "visible" });
      expect(await recorded.page.getByText(defaultCard.title).count()).toBe(0);
      expect(new URL(recorded.page.url()).searchParams.get("board")).toBe("ops");

      const boardFilter = recorded.page.locator(".workboard-select--toolbar-board");
      await chooseWorkboardSelectFieldOption(boardFilter, "All boards", boardFilter);
      await cardInColumn(recorded.page, "Todo", defaultCard.title).waitFor({ state: "visible" });
      expect(new URL(recorded.page.url()).searchParams.has("board")).toBe(false);

      await chooseWorkboardSelectFieldOption(boardFilter, "Operations (ops)", boardFilter);
      await expect.poll(() => new URL(recorded.page.url()).searchParams.get("board")).toBe("ops");
      expect(await recorded.page.getByText(defaultCard.title).count()).toBe(0);
      expect(await recorded.page.getByText("Old work (archive)").count()).toBeGreaterThan(0);
      await captureScreenshot(recorded.page, artifacts, "10-board-filter-ops");
    } finally {
      await closeRecordedPage(recorded, artifacts, "workboard-board-filter");
    }
  });
});
