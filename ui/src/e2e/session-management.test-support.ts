import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export { controlUiSessionPath, controlUiSessionUrl, installMockGateway };

export const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";
export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
export const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "thread-management",
);

export function createSessionManagementE2eSuite() {
  return createControlUiE2eSuite({
    name: "Control UI session management mocked Gateway E2E",
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: {
    archived?: boolean;
    category?: string;
    pinned?: boolean;
    pinnedAt?: number;
    hasActiveRun?: boolean;
    unread?: boolean;
    status?: string;
    spawnedBy?: string;
    startedAt?: number;
    endedAt?: number;
    childSessions?: string[];
    execNode?: string;
    forkSource?: { sessionKey: string; sessionId: string; entryId?: string };
    worktree?: { id?: string; branch?: string; repoRoot?: string };
  } = {},
) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
    ...options,
  };
}

export function sessionsListResponse(
  sessions: unknown[],
  options: {
    hasMore?: boolean;
    nextOffset?: number | null;
    offset?: number;
    totalCount?: number;
  } = {},
) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: options.hasMore ?? false,
    limitApplied: 50,
    nextOffset: options.nextOffset ?? null,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount ?? sessions.length,
    ts: Date.now(),
  };
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

export async function waitForPatch(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("sessions.patch");
    const match = requests.find((request) => predicate(requireRecord(request.params)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`No matching sessions.patch request found: ${JSON.stringify(requests)}`);
}

export async function activateMenuItem(item: Locator): Promise<void> {
  await item.evaluate((element) => (element as HTMLElement).click());
}

export function trimmedTextContents(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim() ?? ""),
  );
}

export function actionOpacity(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).opacity);
}

export function actionPointerEvents(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).pointerEvents);
}

/**
 * Opens a session-menu submenu through the keyboard path. Submenu ARIA is ready
 * before Web Awesome finishes opening the dropdown, so hovering alone races the
 * menu; waiting on its focus contract first keeps navigation keys in order.
 */
export async function openSessionMenuSubmenu(page: Page, name: string): Promise<void> {
  const parent = page.getByRole("menuitem", { name });
  await expect.poll(() => parent.getAttribute("aria-haspopup")).toBe("menu");
  const index = await parent.evaluate((element) =>
    [...(element.parentElement?.children ?? [])]
      .filter(
        (item) =>
          item.localName === "wa-dropdown-item" &&
          item.getAttribute("slot") !== "submenu" &&
          !(item as HTMLElement & { disabled?: boolean }).disabled,
      )
      .indexOf(element),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  await expect
    .poll(() =>
      page.locator("openclaw-session-menu > wa-dropdown > wa-dropdown-item:focus").count(),
    )
    .toBe(1);
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await expect
    .poll(() => parent.evaluate((element) => element === document.activeElement))
    .toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => parent.getAttribute("aria-expanded")).toBe("true");
}

/** Fills the owned input dialog and submits it the way Enter does. */
export async function submitInputDialog(page: Page, value: string): Promise<void> {
  const field = page.locator("openclaw-modal-dialog input");
  await field.waitFor({ state: "visible" });
  await field.fill(value);
  await field.press("Enter");
  await field.waitFor({ state: "detached" });
}

export async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(uiProofArtifactDir, fileName) });
}
