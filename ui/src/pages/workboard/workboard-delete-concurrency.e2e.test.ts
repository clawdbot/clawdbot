// Control UI tests cover deferred Workboard deletion behavior.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayControls,
} from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard deferred deletion E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const viewport = { height: 1000, width: 2400 };
const statuses = [
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

type ProofArtifacts = { directory: string; screenshots: string[]; videos: string[] };
type RecordedPage = { context: BrowserContext; page: Page; rawVideoDir: string };

function createProofArtifacts(): ProofArtifacts {
  return {
    directory: captureUiProofEnabled
      ? createControlUiE2eArtifactDir("workboard-delete-concurrency")
      : "",
    screenshots: [],
    videos: [],
  };
}

function configResponse() {
  const config = { plugins: { entries: { workboard: { enabled: true } } } };
  return {
    config,
    hash: "workboard-delete-concurrency",
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config),
    resolved: config,
    sourceConfig: config,
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

function cardsResponse(cards: WorkboardCard[]) {
  return {
    boards: [
      { id: "default", total: cards.length, active: cards.length, archived: 0, byStatus: {} },
    ],
    cards,
    statuses,
  };
}

function cardInColumn(page: Page, status: string, title: string) {
  return page
    .locator(`.workboard-column--${status.toLowerCase()}`)
    .locator(".workboard-card", { hasText: title })
    .first();
}

async function waitForRequest(gateway: MockGatewayControls, method: string, previousCount: number) {
  await expect
    .poll(async () => (await gateway.getRequests(method)).length)
    .toBeGreaterThan(previousCount);
}

async function newRecordedPage(artifacts: ProofArtifacts): Promise<RecordedPage> {
  const rawVideoDir = path.join(artifacts.directory, "raw");
  if (captureUiProofEnabled) {
    await mkdir(rawVideoDir, { recursive: true });
  }
  const context = await suite.browser.newContext({
    locale: "en-US",
    recordVideo: captureUiProofEnabled ? { dir: rawVideoDir, size: viewport } : undefined,
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  return { context, page, rawVideoDir };
}

async function capture(page: Page, artifacts: ProofArtifacts, name: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  const screenshot = path.join(artifacts.directory, `${name}.png`);
  await page.screenshot({ fullPage: true, path: screenshot });
  artifacts.screenshots.push(screenshot);
}

async function closeRecordedPage(recorded: RecordedPage, artifacts: ProofArtifacts) {
  const video = recorded.page.video();
  await recorded.context.close();
  if (!video) {
    return;
  }
  const videoPath = path.join(artifacts.directory, "workboard-delete-concurrency.webm");
  await copyFile(await video.path(), videoPath);
  artifacts.videos.push(videoPath);
  await rm(recorded.rawVideoDir, { force: true, recursive: true });
}

suite.define(() => {
  it("keeps dependency cleanup while a child card move is pending", async () => {
    const artifacts = createProofArtifacts();
    const parent = card({ id: "delete-parent", status: "done", title: "Delete this parent" });
    const child = card({
      id: "dependent-child",
      metadata: {
        links: [
          { id: "parent-link", type: "parent", targetCardId: parent.id, createdAt: baseTime },
        ],
      },
      position: 2000,
      title: "Move this child",
    });
    const movedChild = card({
      ...child,
      position: 3000,
      status: "blocked",
      updatedAt: baseTime + 1,
    });
    const recorded = await newRecordedPage(artifacts);
    try {
      const gateway = await installMockGateway(recorded.page, {
        methodResponses: {
          "config.get": configResponse(),
          "sessions.list": {
            count: 0,
            defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
            path: "",
            sessions: [],
            ts: baseTime,
          },
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsResponse([parent, child]),
          "workboard.cards.move": { card: movedChild },
        },
      });
      expect((await recorded.page.goto(`${suite.server.baseUrl}workboard`))?.status()).toBe(200);
      await cardInColumn(recorded.page, "done", parent.title).waitFor({ state: "visible" });
      await cardInColumn(recorded.page, "todo", child.title).waitFor({ state: "visible" });
      await expect
        .poll(() =>
          cardInColumn(recorded.page, "todo", child.title)
            .locator(".workboard-dependencies")
            .count(),
        )
        .toBe(1);
      await capture(recorded.page, artifacts, "01-before-delete");

      await gateway.deferNext("workboard.cards.delete");
      await gateway.deferNext("workboard.cards.move");
      const deleteCount = (await gateway.getRequests("workboard.cards.delete")).length;
      await cardInColumn(recorded.page, "done", parent.title)
        .getByRole("button", { name: "Delete card" })
        .click();
      await waitForRequest(gateway, "workboard.cards.delete", deleteCount);
      await expect.poll(() => cardInColumn(recorded.page, "done", parent.title).count()).toBe(0);
      await expect
        .poll(() =>
          cardInColumn(recorded.page, "todo", child.title)
            .locator(".workboard-dependencies")
            .count(),
        )
        .toBe(0);

      const moveCount = (await gateway.getRequests("workboard.cards.move")).length;
      await cardInColumn(recorded.page, "todo", child.title)
        .locator(".workboard-card__move-select")
        .selectOption("blocked");
      await waitForRequest(gateway, "workboard.cards.move", moveCount);
      await gateway.resolveDeferred("workboard.cards.move", { card: movedChild });
      await cardInColumn(recorded.page, "blocked", child.title).waitFor({ state: "visible" });
      await expect
        .poll(() =>
          cardInColumn(recorded.page, "blocked", child.title)
            .locator(".workboard-dependencies")
            .count(),
        )
        .toBe(0);
      await capture(recorded.page, artifacts, "02-pending-delete-child-moved");

      await gateway.resolveDeferred("workboard.cards.delete", { deleted: true });
      await expect.poll(() => cardInColumn(recorded.page, "done", parent.title).count()).toBe(0);
      await expect
        .poll(() =>
          cardInColumn(recorded.page, "blocked", child.title)
            .locator(".workboard-dependencies")
            .count(),
        )
        .toBe(0);
      await capture(recorded.page, artifacts, "03-delete-acknowledged");
    } finally {
      await closeRecordedPage(recorded, artifacts);
    }
    if (captureUiProofEnabled) {
      await writeFile(
        path.join(artifacts.directory, "manifest.json"),
        `${JSON.stringify(artifacts, null, 2)}\n`,
        "utf8",
      );
    }
  });
});
