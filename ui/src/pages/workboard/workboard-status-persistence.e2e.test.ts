import { mkdir } from "node:fs/promises";
import path from "node:path";
// Control UI tests cover workboard status persistence behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
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
  position: 1_000,
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
  await field.locator(".workboard-select__trigger").click();
  await field.getByRole("option", { exact: true, name: optionLabel }).click();
}

async function workboardSelectValue(scope: Page | Locator, label: string): Promise<string> {
  const field = workboardField(scope, label);
  expect(await field.count()).toBe(1);
  return (await field.locator(".workboard-select__value").textContent()) ?? "";
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
      setTimeout(resolve, 50);
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
    await mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("persists edit/reopen fields and does not bounce a dragged linked card from stale lifecycle", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
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
          cards: [initialCard],
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
                patch: {
                  title: "Persisted renamed card",
                  notes: "Edited notes survive reopening.",
                  status: "todo",
                  priority: "high",
                  labels: ["ui"],
                  agentId: "main",
                  sessionKey: linkedSessionKey,
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
      await waitForRequestCount(gateway, "workboard.cards.update", 0);

      await workboardCard(page, "Todo", "Persist queue status")
        .locator('button[aria-label="Edit card"]')
        .click();
      await page.getByLabel("Title").fill("Persisted renamed card");
      await page.getByLabel("Notes").fill("Edited notes survive reopening.");
      await chooseWorkboardSelectOption(page, "Priority", "High");
      await page.getByRole("button", { name: "Save" }).click();

      const updateRequests = await waitForRequestCount(gateway, "workboard.cards.update", 1);
      expect(
        requestParams(expectDefined(updateRequests[0], "workboard update request")),
      ).toMatchObject({
        id: "card-1",
        patch: {
          notes: "Edited notes survive reopening.",
          priority: "high",
          status: "todo",
          title: "Persisted renamed card",
        },
      });
      try {
        await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 10_000 });
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
      await page.locator('[role="dialog"]').waitFor({ timeout: 10_000 });
      await expect.poll(() => page.getByLabel("Title").inputValue()).toBe("Persisted renamed card");
      await expect
        .poll(() => page.getByLabel("Notes").inputValue())
        .toBe("Edited notes survive reopening.");
      await expect.poll(() => workboardSelectValue(page, "Priority")).toBe("High");
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "workboard-edit-reopen.png"),
      });
      await page
        .locator('[role="dialog"] .workboard-modal__actions')
        .last()
        .getByRole("button", { name: "Cancel" })
        .click();
      await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 10_000 });

      await dispatchHtml5Drag(
        workboardCard(page, "Todo", "Persisted renamed card"),
        workboardColumn(page, "Running").locator(".workboard-column__cards"),
      );
      const moveRequest = await gateway.waitForRequest("workboard.cards.move");
      expect(requestParams(moveRequest)).toMatchObject({
        id: "card-1",
        position: 1_000,
        status: "running",
      });
      await workboardCard(page, "Running", "Persisted renamed card").waitFor({
        timeout: 10_000,
      });
      await waitForRequestCount(gateway, "workboard.cards.update", 1);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "workboard-drag-running-persisted.png"),
      });
    } finally {
      await context.close();
    }
  });
});
