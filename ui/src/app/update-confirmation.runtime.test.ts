/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  closeFailedUpdateDialog,
  confirmAndStartUpdateRuntime,
} from "./update-confirmation.runtime.ts";
import type { UpdateProgress } from "./update-confirmation.ts";

/** Drives the dialog the way the shell does: one live lifecycle stream. */
function createProgressStream() {
  let emit: ((progress: UpdateProgress) => void) | null = null;
  let stopped = false;
  return {
    get stopped() {
      return stopped;
    },
    watchUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
      emit = listener;
      listener({ busy: false, connected: true, failure: null });
      return () => {
        stopped = true;
      };
    },
    async push(progress: UpdateProgress) {
      emit?.(progress);
      await Promise.resolve();
    },
  };
}

const UPDATE_AVAILABLE: UpdateAvailable = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
};

let restoreDialogPolyfill: () => void;
let originalWebkit: PropertyDescriptor | undefined;

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

function installNativeBridge(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn();
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: { messageHandlers: { openclawUpdate: { postMessage } } },
  });
  return postMessage;
}

function startUpdate(
  overrides: {
    startGatewayUpdate?: () => void;
    updateAvailable?: UpdateAvailable | null;
    updateSchedule?: UpdateScheduleState | null;
    viaNativeApp?: boolean;
    watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
  } = {},
) {
  const startGatewayUpdate = vi.fn();
  const settled = confirmAndStartUpdateRuntime({
    ...(overrides.watchUpdateProgress
      ? { watchUpdateProgress: overrides.watchUpdateProgress }
      : {}),
    startGatewayUpdate: overrides.startGatewayUpdate ?? startGatewayUpdate,
    updateAvailable:
      overrides.updateAvailable === undefined ? UPDATE_AVAILABLE : overrides.updateAvailable,
    updateSchedule: overrides.updateSchedule ?? null,
    viaNativeApp: overrides.viaNativeApp ?? false,
  });
  return { settled, startGatewayUpdate };
}

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialogPolyfill();
  if (originalWebkit) {
    Object.defineProperty(window, "webkit", originalWebkit);
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
});

it("hands a confirmed update to the Mac app instead of the Gateway", async () => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({ viaNativeApp: true });
  const { dialog } = await getRenderedModalDialog(document.body);

  expect(dialog.getAttribute("aria-label")).toBe("Update Mac app + Gateway");
  findButton("Update Mac app and restart").click();
  await settled;

  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "start-update" });
  expect(startGatewayUpdate).not.toHaveBeenCalled();
});

it("falls back to the Gateway when the Mac bridge disappears during confirmation", async () => {
  installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({ viaNativeApp: true });
  await getRenderedModalDialog(document.body);

  Reflect.deleteProperty(window, "webkit");
  findButton("Update Mac app and restart").click();
  await settled;

  expect(startGatewayUpdate).toHaveBeenCalledOnce();
});

it("shows the git target when no package version is available", async () => {
  const { settled } = startUpdate({
    updateAvailable: null,
    updateSchedule: {
      target: { commitsBehind: 3, kind: "git" },
    } as unknown as UpdateScheduleState,
  });
  const { modal } = await getRenderedModalDialog(document.body);

  expect(modal.textContent).toContain("3 commits behind");

  findButton("Cancel").click();
  await settled;
});

it("states a git distance once instead of labelling it as an available version", async () => {
  const { settled } = startUpdate({
    updateAvailable: { channel: "dev", currentVersion: "2026.8.1", latestVersion: "2026.8.1" },
    updateSchedule: {
      target: { commitsBehind: 246, kind: "git" },
    } as unknown as UpdateScheduleState,
  });
  const { modal } = await getRenderedModalDialog(document.body);

  expect(modal.textContent).toContain("Installed v2026.8.1 · 246 commits behind");
  expect(modal.textContent).not.toContain("Available 246");

  findButton("Cancel").click();
  await settled;
});

it("keeps a repeated request from stacking a second confirmation or update", async () => {
  const first = startUpdate();
  const second = startUpdate();
  await getRenderedModalDialog(document.body);

  await second.settled;
  expect(document.body.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
  expect(second.startGatewayUpdate).not.toHaveBeenCalled();

  findButton("Update and restart").click();
  await first.settled;
  expect(first.startGatewayUpdate).toHaveBeenCalledOnce();
});

it("keeps the dialog open and narrates the install, the restart, and the failure", async () => {
  const stream = createProgressStream();
  const { settled, startGatewayUpdate } = startUpdate({
    watchUpdateProgress: stream.watchUpdateProgress,
  });
  const { modal } = await getRenderedModalDialog(document.body);

  findButton("Update and restart").click();
  await Promise.resolve();
  expect(startGatewayUpdate).toHaveBeenCalledOnce();
  const updating = findButton("Updating…");
  expect(updating.disabled).toBe(true);
  expect(modal.textContent).toContain("Installing the update on the Gateway");

  // The Gateway goes away mid-install; the dialog is mounted outside the shell
  // precisely so it can keep reporting through the disconnect.
  await stream.push({ busy: true, connected: false, failure: null });
  expect(modal.textContent).toContain("The Gateway is restarting");
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

  await stream.push({
    busy: false,
    connected: true,
    failure: "The update failed at install: ENOSPC: no space left on device, write.",
  });
  expect(modal.textContent).toContain("ENOSPC: no space left on device");
  findButton("Close").click();
  await settled;
  expect(stream.stopped).toBe(true);
});

it("closes itself once a watched update finishes without a failure", async () => {
  const stream = createProgressStream();
  const { settled } = startUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
  await getRenderedModalDialog(document.body);

  findButton("Update and restart").click();
  await Promise.resolve();
  await stream.push({ busy: true, connected: true, failure: null });
  await stream.push({ busy: false, connected: true, failure: null });

  await settled;
  expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
});

it("hands only a failed dialog over to triage", async () => {
  const stream = createProgressStream();
  const { settled } = startUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
  await getRenderedModalDialog(document.body);
  closeFailedUpdateDialog();
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
  findButton("Update and restart").click();
  await stream.push({ busy: true, connected: true, failure: null });
  closeFailedUpdateDialog();
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

  await stream.push({
    busy: false,
    connected: true,
    failure: "Read the recorded cause before retrying.",
  });
  closeFailedUpdateDialog();
  await settled;
  expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(stream.stopped).toBe(true);
});

/**
 * Retry after a failure: the shell keeps the previous attempt's banner until an
 * accepted run clears it, and producers replay the current snapshot as their
 * subscribe-time emit. `accepted: false` models `overlays.runUpdate` refusing
 * the request (disconnected, already running, no admin), which leaves the
 * banner in place.
 */
function createRetryStream(options: { accepted: boolean }) {
  let progress: UpdateProgress = {
    busy: false,
    connected: true,
    failure: "The update failed at install: ENOSPC: no space left on device, write.",
  };
  let emit: ((next: UpdateProgress) => void) | null = null;
  return {
    startGatewayUpdate: () => {
      if (!options.accepted) {
        return;
      }
      progress = { busy: true, connected: true, failure: null };
      emit?.(progress);
    },
    watchUpdateProgress: (listener: (next: UpdateProgress) => void) => {
      emit = listener;
      listener(progress);
      return () => {};
    },
  };
}

it("reports a refused retry as unanswered rather than as the old failure", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const stream = createRetryStream({ accepted: false });
    const { settled } = startUpdate({
      startGatewayUpdate: stream.startGatewayUpdate,
      watchUpdateProgress: stream.watchUpdateProgress,
    });
    const { modal } = await getRenderedModalDialog(document.body);

    findButton("Update and restart").click();
    await Promise.resolve();
    // The refused request must not inherit the previous error as its outcome.
    expect(modal.textContent).not.toContain("ENOSPC");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(modal.textContent).toContain("The update request went unanswered");
    findButton("Close").click();
    await settled;
  } finally {
    vi.useRealTimers();
  }
});

it("reports a request the Gateway never accepted instead of spinning forever", async () => {
  // Auto-advancing keeps the modal's own animation frames running while the
  // grace deadline is fast-forwarded.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const stream = createProgressStream();
    const { settled } = startUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
    const { modal } = await getRenderedModalDialog(document.body);

    findButton("Update and restart").click();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(modal.textContent).toContain("The update request went unanswered");
    findButton("Close").click();
    await settled;
  } finally {
    vi.useRealTimers();
  }
});
