// Control UI tests cover workboard behavior.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { WORKBOARD_STATUSES, type WorkboardCard } from "../controllers/workboard.ts";
import type { GatewaySessionRow } from "../types.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/workboard");
const viewport = { height: 1000, width: 2400 };
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const linkedSessionKey = "agent:main:workboard-proof";
const linkedSessionName = "Implementation session";

let browser: Browser;
let server: ControlUiE2eServer;

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
      setTimeout(resolve, 50);
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

function cardsListResponse(cards: WorkboardCard[]) {
  return {
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
  const context = await browser.newContext({
    locale: "en-US",
    recordVideo: {
      dir: rawVideoDir,
      size: viewport,
    },
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return { context, page, rawVideoDir };
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
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
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

    const writable = await newRecordedPage("workboard-writable");
    const writableGateway = await installMockGateway(writable.page, {
      methodResponses: {
        "config.get": workboardConfigSnapshot(),
        "sessions.list": sessionsListResponse([sessionRow()]),
        "tasks.list": { nextCursor: null, tasks: [] },
        "workboard.cards.list": cardsListResponse([]),
      },
    });

    try {
      const response = await writable.page.goto(`${server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await statusColumn(writable.page, "Todo").waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "01-empty-board");

      await writableGateway.deferNext("workboard.cards.create");
      await writable.page
        .locator(".workboard-toolbar__actions")
        .getByRole("button", { name: /New card/u })
        .click();
      const createDialog = writable.page.getByRole("dialog", { name: "New card" });
      await createDialog.getByLabel("Title").fill(createdCard.title);
      await createDialog.getByLabel("Notes").fill(createdCard.notes ?? "");
      await createDialog.getByLabel("Session").selectOption(linkedSessionKey);
      await createDialog.getByLabel("Labels").fill("ui, proof");
      await captureScreenshot(writable.page, artifacts, "02-create-dialog");
      const createBefore = (await writableGateway.getRequests("workboard.cards.create")).length;
      await createDialog.getByRole("button", { name: /^Create$/u }).click();
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
      await writableGateway.resolveDeferred("workboard.cards.create", { card: createdCard });
      await cardInColumn(writable.page, "Todo", createdCard.title).waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "03-created-card");

      await writableGateway.deferNext("workboard.cards.update");
      await cardInColumn(writable.page, "Todo", createdCard.title)
        .locator('button[title="Edit card"]')
        .click();
      const editDialog = writable.page.getByRole("dialog", { name: "Edit card" });
      await editDialog.getByLabel("Title").fill(editedCard.title);
      await editDialog.getByLabel("Notes").fill(editedCard.notes ?? "");
      await editDialog.getByLabel("Priority").selectOption("high");
      await editDialog.getByLabel("Labels").fill("ui, proof, e2e");
      const updateBeforeEdit = (await writableGateway.getRequests("workboard.cards.update")).length;
      await editDialog.getByRole("button", { name: /^Save$/u }).click();
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
      await details.locator('button[title="Cancel"]').click();

      await writableGateway.deferNext("workboard.cards.move");
      const moveBefore = (await writableGateway.getRequests("workboard.cards.move")).length;
      await cardInColumn(writable.page, "Todo", editedCard.title).dragTo(
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
      await captureScreenshot(writable.page, artifacts, "05-moved-running");

      await writableGateway.deferNext("workboard.cards.update");
      const syncBefore = (await writableGateway.getRequests("workboard.cards.update")).length;
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
      const syncRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.update",
        syncBefore,
      );
      expect(requestParams(syncRequest)).toMatchObject({ id: runningCard.id });
      expect(requireRecord(requestParams(syncRequest).patch)).toMatchObject({
        status: "review",
      });
      await writableGateway.resolveDeferred("workboard.cards.update", { card: reviewedCard });
      const reviewedCardSurface = cardInColumn(writable.page, "Review", editedCard.title);
      await reviewedCardSurface.waitFor({ state: "visible" });
      await reviewedCardSurface.getByTitle("View details").click();
      await writable.page.locator(".workboard-detail").getByText("Moved to Review").waitFor({
        state: "visible",
      });
      await captureScreenshot(writable.page, artifacts, "06-lifecycle-review");
      await details.locator('button[title="Cancel"]').click();
      await details.waitFor({ state: "hidden" });

      await writableGateway.deferNext("workboard.cards.list");
      const listBeforeReload = (await writableGateway.getRequests("workboard.cards.list")).length;
      await writable.page
        .locator(".workboard-toolbar__actions")
        .getByRole("button", { name: /^Refresh$/u })
        .click();
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeReload);
      await writableGateway.resolveDeferred("workboard.cards.list", {
        cards: [reviewedCard],
        statuses: WORKBOARD_STATUSES,
      });
      await cardInColumn(writable.page, "Review", editedCard.title).waitFor({ state: "visible" });
      await writable.page.getByText("Acceptance: mocked Gateway browser proof").waitFor({
        state: "visible",
      });
      await captureScreenshot(writable.page, artifacts, "07-reloaded-review");
    } finally {
      await closeRecordedPage(writable, artifacts, "workboard-writable");
    }

    const readOnly = await newRecordedPage("workboard-read-only");
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

    try {
      const response = await readOnly.page.goto(`${server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await cardInColumn(readOnly.page, "Running", editedCard.title).waitFor({
        state: "visible",
      });
      await captureScreenshot(readOnly.page, artifacts, "08-read-only-board");
      expect(await readOnly.page.getByRole("button", { name: /New card/u }).count()).toBe(0);
      expect(await readOnly.page.locator('button[title="Edit card"]').count()).toBe(0);
      expect(await readOnly.page.locator('button[title="Delete card"]').count()).toBe(0);
      expect(await readOnly.page.locator('button[title="Run default agent"]').count()).toBe(0);
      expect(
        await cardInColumn(readOnly.page, "Running", editedCard.title).getAttribute("draggable"),
      ).toBe("false");

      await cardInColumn(readOnly.page, "Running", editedCard.title).click();
      await readOnly.page.locator(".workboard-detail").getByText(editedCard.title).waitFor({
        state: "visible",
      });
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
});
