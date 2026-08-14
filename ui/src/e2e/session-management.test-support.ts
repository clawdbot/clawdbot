import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  waitForConfirmModal,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export { controlUiSessionPath, controlUiSessionUrl, installMockGateway, waitForConfirmModal };

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
    sessionId?: string;
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
    sessionId: `session:${key}`,
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

export const requireRecord = createRequireRecord("record", "expected-object-value");

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

/** Dispatches before a successful action can remove its own control from the DOM. */
export async function activateSelfRemovingControl(control: Locator): Promise<void> {
  await control.evaluate((element) => {
    const target = element as HTMLElement & { disabled?: boolean };
    const style = getComputedStyle(target);
    const bounds = target.getBoundingClientRect();
    const root = target.getRootNode();
    const hitTestRoot = root instanceof ShadowRoot ? root : document;
    const hitTarget = hitTestRoot.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    if (
      !target.isConnected ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      target.disabled === true ||
      target.getAttribute("aria-disabled") === "true" ||
      !hitTarget ||
      (hitTarget !== target && !target.contains(hitTarget))
    ) {
      throw new Error("Self-removing control must be visible and enabled before activation");
    }
    target.click();
  });
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
 * What a pointer would actually land on at the centre of `locator`. Row actions
 * float over the link, so "is it revealed" and "does the click reach it" are
 * separate questions and only this one answers the second.
 */
export function hitTargetAtCentre(locator: Locator): Promise<"action" | "link" | "other"> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (hit?.closest(".session-row-actions")) {
      return "action";
    }
    return hit?.closest(".sidebar-recent-session__link") ? "link" : "other";
  });
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

const PROOF_CLIP_MARGIN = 12;

/**
 * Screenshots the state the caller just built. Pass `clip` to frame the union of
 * those locators: hover cards and row menus are absolutely positioned, so a
 * frame drawn around the row alone would cut off the surface the capture exists
 * to show.
 */
export async function captureUiProof(
  page: Page,
  fileName: string,
  options: { clip?: readonly Locator[]; keepAnimations?: boolean } = {},
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  const boxes = await Promise.all((options.clip ?? []).map((locator) => locator.boundingBox()));
  const present = boxes.filter((box) => box !== null);
  const left = Math.min(...present.map((box) => box.x)) - PROOF_CLIP_MARGIN;
  const top = Math.min(...present.map((box) => box.y)) - PROOF_CLIP_MARGIN;
  const clip =
    present.length === 0
      ? undefined
      : {
          x: Math.max(0, left),
          y: Math.max(0, top),
          width: Math.max(...present.map((box) => box.x + box.width)) + PROOF_CLIP_MARGIN - left,
          height: Math.max(...present.map((box) => box.y + box.height)) + PROOF_CLIP_MARGIN - top,
        };
  // Dialogs and menus fade in, so an undisabled capture can land mid-transition
  // and prove nothing about the state it was taken for. `keepAnimations` is for
  // the opposite case: an endless animation is cancelled to its first frame, so
  // a caller proving one must hold it at a phase itself and keep it there.
  await page.screenshot({
    animations: options.keepAnimations ? "allow" : "disabled",
    clip,
    fullPage: clip === undefined,
    path: path.join(uiProofArtifactDir, fileName),
  });
}
