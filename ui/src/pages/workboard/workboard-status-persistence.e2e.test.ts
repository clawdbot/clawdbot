import { mkdir } from "node:fs/promises";
import path from "node:path";
// Control UI tests cover workboard status persistence behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "workboard-status-persistence",
);

let browser: Browser;
let server: ControlUiE2eServer;

const linkedSessionKey = "agent:main:workboard-linked-session";
const manualTodoAt = 2_000;
const editedAt = 2_500;
const draggedRunningAt = 3_000;
const staleCompletedSessionAt = 1_000;

const initialCard = {
  id: "card-1",
  title: "Persist queue status",
  notes: "Original notes",
  status: "todo",
  priority: "normal",
  labels: ["ui"],
  agentId: "main",
  position: 1_000,
  createdAt: 900,
  updatedAt: manualTodoAt,
  sessionKey: linkedSessionKey,
  events: [
    {
      id: "event-manual-todo",
      kind: "moved",
      at: manualTodoAt,
      fromStatus: "running",
      toStatus: "todo",
    },
  ],
} satisfies WorkboardCard;

const productRunningCard = {
  id: "product-running-card",
  title: "Product board running card",
  status: "running",
  priority: "normal",
  labels: [],
  position: 9_000,
  createdAt: 900,
  updatedAt: manualTodoAt,
  metadata: { automation: { boardId: "product" } },
} satisfies WorkboardCard;

const archivedDefaultRunningCard = {
  id: "archived-default-running-card",
  title: "Archived default board running card",
  status: "running",
  priority: "normal",
  labels: [],
  position: 3_000,
  createdAt: 900,
  updatedAt: manualTodoAt,
  metadata: { archivedAt: 1_000 },
} satisfies WorkboardCard;

const editedCard = {
  ...initialCard,
  title: "Persisted renamed card",
  notes: "Edited notes survive reopening.",
  priority: "high",
  updatedAt: editedAt,
  events: [...initialCard.events, { id: "event-edited", kind: "edited", at: editedAt }],
} satisfies WorkboardCard;

const draggedRunningCard = {
  ...editedCard,
  status: "running",
  position: 4_000,
  updatedAt: draggedRunningAt,
  events: [
    ...editedCard.events,
    {
      id: "event-manual-running",
      kind: "moved",
      at: draggedRunningAt,
      fromStatus: "todo",
      toStatus: "running",
    },
  ],
} satisfies WorkboardCard;

const staleReviewCard = {
  ...draggedRunningCard,
  status: "review",
  updatedAt: draggedRunningAt + 500,
  events: [
    ...draggedRunningCard.events,
    {
      id: "event-stale-review",
      kind: "moved",
      at: draggedRunningAt + 500,
      fromStatus: "running",
      toStatus: "review",
    },
  ],
} satisfies WorkboardCard;

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

async function chooseWorkboardSelectOption(
  scope: Page | Locator,
  label: string,
  optionLabel: string,
): Promise<void> {
  const field = workboardField(scope, label);
  expect(await field.count()).toBe(1);
  const optionValue = await field.locator("option").evaluateAll((options, optionText) => {
    const option = options.find((candidate) =>
      candidate.textContent?.trim().startsWith(optionText),
    );
    return option?.getAttribute("value") ?? null;
  }, optionLabel);
  await field
    .locator("select")
    .selectOption(expectDefined(optionValue, `Workboard option: ${optionLabel}`));
}

async function workboardSelectLabel(scope: Page | Locator, label: string): Promise<string> {
  const field = workboardField(scope, label);
  expect(await field.count()).toBe(1);
  return (await field.locator("option:checked").textContent())?.trim() ?? "";
}

function workboardColumn(page: Page, title: string) {
  return page.locator(".workboard-column", {
    has: page.getByRole("heading", { name: title }),
  });
}

function workboardCard(page: Page, columnTitle: string, title: string) {
  return workboardColumn(page, columnTitle).locator(".workboard-card", { hasText: title });
}

async function dispatchHtml5Drag(source: Locator, target: Locator): Promise<void> {
  const sourceHandle = await source.elementHandle();
  const targetHandle = await target.elementHandle();
  if (!sourceHandle || !targetHandle) {
    throw new Error("Could not resolve Workboard drag source or target");
  }
  try {
    await sourceHandle.evaluate((sourceElement, targetElement) => {
      const dataTransfer = new DataTransfer();
      const init = { bubbles: true, cancelable: true, dataTransfer };
      sourceElement.dispatchEvent(new DragEvent("dragstart", init));
      targetElement.dispatchEvent(new DragEvent("dragover", init));
      targetElement.dispatchEvent(new DragEvent("drop", init));
      sourceElement.dispatchEvent(new DragEvent("dragend", init));
    }, targetHandle);
  } finally {
    await sourceHandle.dispose();
    await targetHandle.dispose();
  }
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  let stableSince: number | null = null;
  let latest: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    latest = await gateway.getRequests(method);
    if (latest.length === count) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 250) {
        return latest;
      }
    } else {
      stableSince = null;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(
    `Timed out waiting for exactly ${count} ${method} requests: ${JSON.stringify(latest)}`,
  );
}

describeControlUiE2e("Control UI Workboard status persistence E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    if (captureUiProofEnabled) {
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("preserves an execution-owned session when editing a linked Workboard card", async () => {
    const executionLinkedCard: WorkboardCard = {
      ...initialCard,
      title: "Keep my execution-linked session",
      status: "running",
      execution: {
        id: "execution-linked-card-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: linkedSessionKey,
        startedAt: 900,
        updatedAt: manualTodoAt,
      },
    };
    delete executionLinkedCard.sessionKey;
    const updatedCard: WorkboardCard = {
      ...executionLinkedCard,
      title: "Renamed without unlinking the execution",
      updatedAt: editedAt,
    };
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      ...workboardUi,
      methodResponses: {
        "config.get": {
          config: {
            plugins: {
              entries: {
                workboard: { enabled: true },
              },
            },
          },
          hash: "execution-linked-workboard-e2e-config",
        },
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: null,
              displayName: "Execution linked session",
              hasActiveRun: true,
              key: linkedSessionKey,
              kind: "direct",
              label: "Execution linked session",
              model: "gpt-5.5",
              modelProvider: "openai",
              status: "running",
              totalTokens: 0,
              updatedAt: manualTodoAt,
            },
          ],
          ts: Date.now(),
        },
        "tasks.list": { nextCursor: null, tasks: [] },
        "workboard.cards.list": {
          cards: [executionLinkedCard],
          statuses: [
            "triage",
            "backlog",
            "todo",
            "scheduled",
            "ready",
            "running",
            "review",
            "blocked",
            "done",
          ],
        },
        "workboard.cards.update": { card: updatedCard },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      const executionCard = page.locator(".workboard-card", {
        hasText: executionLinkedCard.title,
      });
      await executionCard.waitFor({ timeout: 10_000 });

      await executionCard.locator('button[aria-label="Edit card"]').click();
      const editDialog = page.getByRole("dialog", { name: "Edit card" });
      await editDialog.waitFor({ timeout: 10_000 });
      await expect
        .poll(() => workboardSelectLabel(page, "Session"))
        .toBe("Execution linked session");

      await page.getByLabel("Title").fill(updatedCard.title);
      await page.getByRole("button", { name: "Save" }).click();

      const requests = await waitForRequestCount(gateway, "workboard.cards.update", 1);
      expect(requestParams(expectDefined(requests[0], "execution-linked card update"))).toEqual({
        id: executionLinkedCard.id,
        expectedUpdatedAt: executionLinkedCard.updatedAt,
        patch: { title: updatedCard.title },
      });
      await editDialog.waitFor({ state: "detached", timeout: 10_000 });
      await page.locator(".workboard-card", { hasText: updatedCard.title }).waitFor({
        timeout: 10_000,
      });
    } finally {
      await context.close();
    }
  });

  it("persists edit/reopen fields and does not bounce a dragged linked card from stale lifecycle", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureUiProofEnabled
        ? { dir: artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      ...workboardUi,
      methodResponses: {
        "config.get": {
          config: {
            plugins: {
              entries: {
                workboard: { enabled: true },
              },
            },
          },
          hash: "workboard-e2e-config",
        },
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: null,
              displayName: "Completed linked session",
              hasActiveRun: false,
              key: linkedSessionKey,
              kind: "direct",
              label: "Completed linked session",
              model: "gpt-5.5",
              modelProvider: "openai",
              status: "done",
              totalTokens: 0,
              updatedAt: staleCompletedSessionAt,
            },
          ],
          ts: Date.now(),
        },
        "tasks.list": {
          nextCursor: null,
          tasks: [],
        },
        "workboard.cards.list": {
          cards: [initialCard, productRunningCard, archivedDefaultRunningCard],
          statuses: [
            "triage",
            "backlog",
            "todo",
            "scheduled",
            "ready",
            "running",
            "review",
            "blocked",
            "done",
          ],
        },
        "workboard.cards.move": {
          card: draggedRunningCard,
        },
        "workboard.cards.update": {
          cases: [
            {
              match: {
                id: "card-1",
                expectedUpdatedAt: initialCard.updatedAt,
                patch: {
                  title: "Persisted renamed card",
                  notes: "Edited notes survive reopening.",
                  priority: "high",
                },
              },
              response: { card: editedCard },
            },
            {
              match: {
                id: "card-1",
                patch: { status: "review" },
              },
              response: { card: staleReviewCard },
            },
          ],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await workboardCard(page, "Todo", "Persist queue status").waitFor({ timeout: 10_000 });
      await workboardCard(page, "Running", productRunningCard.title).waitFor({
        timeout: 10_000,
      });
      await expect.poll(() => page.getByText(archivedDefaultRunningCard.title).count()).toBe(0);
      await waitForRequestCount(gateway, "workboard.cards.update", 0);

      await workboardCard(page, "Todo", "Persist queue status")
        .locator('button[aria-label="Edit card"]')
        .click();
      const editDialog = page.getByRole("dialog", { name: "Edit card" });
      await editDialog.waitFor({ timeout: 10_000 });
      await page.getByLabel("Title").fill("Persisted renamed card");
      await page.getByLabel("Notes").fill("Edited notes survive reopening.");
      await chooseWorkboardSelectOption(page, "Priority", "High");
      await page.getByRole("button", { name: "Save" }).click();

      const updateRequests = await waitForRequestCount(gateway, "workboard.cards.update", 1);
      expect(requestParams(expectDefined(updateRequests[0], "workboard update request"))).toEqual({
        id: "card-1",
        expectedUpdatedAt: initialCard.updatedAt,
        patch: {
          notes: "Edited notes survive reopening.",
          priority: "high",
          title: "Persisted renamed card",
        },
      });
      try {
        await editDialog.waitFor({ state: "detached", timeout: 10_000 });
      } catch (err) {
        const requests = await gateway.getRequests("workboard.cards.update");
        throw new Error(
          `Edit dialog stayed open after save. Update requests: ${JSON.stringify(requests)}`,
          { cause: err },
        );
      }
      await workboardCard(page, "Todo", "Persisted renamed card").waitFor({ timeout: 10_000 });

      await workboardCard(page, "Todo", "Persisted renamed card")
        .locator('button[aria-label="Edit card"]')
        .click();
      await editDialog.waitFor({ timeout: 10_000 });
      await expect.poll(() => page.getByLabel("Title").inputValue()).toBe("Persisted renamed card");
      await expect
        .poll(() => page.getByLabel("Notes").inputValue())
        .toBe("Edited notes survive reopening.");
      await expect.poll(() => workboardSelectLabel(page, "Priority")).toBe("High");
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "workboard-edit-reopen.png"),
        });
      }
      await page
        .locator(".workboard-draft > .workboard-modal__actions")
        .last()
        .getByRole("button", { name: "Cancel" })
        .click();
      await editDialog.waitFor({ state: "detached", timeout: 10_000 });

      await dispatchHtml5Drag(
        workboardCard(page, "Todo", "Persisted renamed card"),
        workboardColumn(page, "Running").locator(".workboard-column__cards"),
      );
      const moveRequest = await gateway.waitForRequest("workboard.cards.move");
      expect(requestParams(moveRequest)).toMatchObject({
        id: "card-1",
        position: 4_000,
        status: "running",
      });
      await workboardCard(page, "Running", "Persisted renamed card").waitFor({
        timeout: 10_000,
      });
      await waitForRequestCount(gateway, "workboard.cards.update", 1);
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "workboard-drag-running-persisted.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
