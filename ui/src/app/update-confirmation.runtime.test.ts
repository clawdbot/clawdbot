/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { confirmAndStartUpdateRuntime } from "./update-confirmation.runtime.ts";
import { createUpdateProgressWatcher, type UpdateProgress } from "./update-confirmation.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

/** Drives the dialog the way the shell does: one live lifecycle stream. */
function createProgressStream(
  initial: UpdateProgress = { run: null, busy: false, connected: true, failure: null },
) {
  let emit: ((progress: UpdateProgress) => void) | null = null;
  let stopped = false;
  return {
    get stopped() {
      return stopped;
    },
    watchUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
      emit = listener;
      listener(initial);
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
  document.body.querySelector("openclaw-modal-dialog")?.dispatchEvent(new Event("modal-cancel"));
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

it("keeps the dialog open and narrates the install, the disconnect, and the failure", async () => {
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
  await stream.push({ run: null, busy: true, connected: false, failure: null });
  expect(modal.textContent).toContain("The Gateway disconnected during the update");
  expect(modal.textContent).toContain("openclaw triage");
  expect(modal.textContent).toContain("on the Gateway host");
  expect(modal.textContent).toContain("local coding agent");
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

  await stream.push({
    run: null,
    busy: false,
    connected: true,
    failure: "The update failed at install: ENOSPC: no space left on device, write.",
  });
  expect(modal.textContent).toContain("ENOSPC: no space left on device");
  findButton("Close").click();
  await settled;
  expect(stream.stopped).toBe(true);
});

it("keeps the server success report visible across restart until the operator closes it", async () => {
  const stream = createProgressStream();
  const { settled } = startUpdate({ watchUpdateProgress: stream.watchUpdateProgress });
  await getRenderedModalDialog(document.body);
  findButton("Update and restart").click();
  const restarting = createUpdateRunFixture({ phase: "restarting" });
  await stream.push({ run: restarting, busy: true, connected: false, failure: null });
  const view = document.body.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "openclaw-update-run-view",
  )!;
  await view.updateComplete;
  expect(view.textContent).toContain("Gateway restarting…");
  await stream.push({
    run: createUpdateRunFixture({
      phase: "finished",
      status: "succeeded",
      after: { version: "2026.9.2" },
      finishedAtMs: 10,
    }),
    busy: false,
    connected: true,
    failure: null,
  });
  await view.updateComplete;
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
  expect(view.querySelector(".update-run-view__report")?.textContent).toContain(
    "OpenClaw updated to 2026.9.2",
  );
  findButton("Close").click();
  await settled;
  expect(stream.stopped).toBe(true);
});

it("opens a saved run without starting another update and acknowledges its report on close", async () => {
  const onAcknowledge = vi.fn();
  const startGatewayUpdate = vi.fn();
  const settled = confirmAndStartUpdateRuntime({
    existingRun: createUpdateRunFixture({
      phase: "finished",
      status: "succeeded",
      finishedAtMs: 10,
    }),
    startGatewayUpdate,
    onAcknowledge,
    updateAvailable: null,
    updateSchedule: null,
    viaNativeApp: false,
  });
  await getRenderedModalDialog(document.body);
  expect(document.body.querySelector("openclaw-update-run-view")).not.toBeNull();
  expect(startGatewayUpdate).not.toHaveBeenCalled();
  findButton("Close").click();
  await settled;
  expect(onAcknowledge).toHaveBeenCalledOnce();
});

it.each(["existing", "started"] as const)(
  "clears a %s run report when its scoped row is retired",
  async (entry) => {
    const run = createUpdateRunFixture(
      entry === "existing" ? { phase: "finished", status: "succeeded", finishedAtMs: 10 } : {},
    );
    const progress: UpdateProgress = {
      run,
      busy: run.status === "running",
      connected: true,
      failure: null,
    };
    const stream = createProgressStream(entry === "existing" ? progress : undefined);
    const onAcknowledge = vi.fn();
    const settled = confirmAndStartUpdateRuntime({
      ...(entry === "existing" ? { existingRun: run } : {}),
      onAcknowledge,
      startGatewayUpdate: vi.fn(),
      watchUpdateProgress: stream.watchUpdateProgress,
      updateAvailable: UPDATE_AVAILABLE,
      updateSchedule: null,
      viaNativeApp: false,
    });
    await getRenderedModalDialog(document.body);
    if (entry === "started") {
      findButton("Update and restart").click();
      await stream.push(progress);
    }
    expect(document.body.querySelector("openclaw-update-run-view")).not.toBeNull();

    await stream.push({ run: null, busy: false, connected: false, failure: null });

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(document.body.classList.contains("update-dialog-open")).toBe(false);
    expect(stream.stopped).toBe(true);
    expect(onAcknowledge).not.toHaveBeenCalled();
    await settled;
  },
);

it("unsubscribes when the initial snapshot retires a saved run before subscription returns", async () => {
  const stopWatching = vi.fn();
  const settled = confirmAndStartUpdateRuntime({
    existingRun: createUpdateRunFixture({
      phase: "finished",
      status: "succeeded",
      finishedAtMs: 10,
    }),
    startGatewayUpdate: vi.fn(),
    watchUpdateProgress: (listener) => {
      listener({ run: null, busy: false, connected: true, failure: null });
      return stopWatching;
    },
    updateAvailable: null,
    updateSchedule: null,
    viaNativeApp: false,
  });

  expect(stopWatching).toHaveBeenCalledOnce();
  expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(document.body.classList.contains("update-dialog-open")).toBe(false);
  await settled;
});

it("keeps the failure visible until the operator explicitly opens its review action", async () => {
  const stream = createProgressStream();
  const onReviewUpdate = vi.fn();
  const settled = confirmAndStartUpdateRuntime({
    startGatewayUpdate: vi.fn(),
    watchUpdateProgress: stream.watchUpdateProgress,
    onReviewUpdate,
    updateAvailable: UPDATE_AVAILABLE,
    updateSchedule: null,
    viaNativeApp: false,
  });
  await getRenderedModalDialog(document.body);
  findButton("Update and restart").click();
  await stream.push({
    run: null,
    busy: false,
    connected: true,
    failure: "Read the recorded cause before retrying.",
  });
  expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
    "Read the recorded cause",
  );
  expect(onReviewUpdate).not.toHaveBeenCalled();
  findButton("Review update").click();
  await settled;
  expect(onReviewUpdate).toHaveBeenCalledOnce();
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
    run: null,
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
      progress = { run: null, busy: true, connected: true, failure: null };
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

it.each([
  { status: "running", entry: "existing" },
  { status: "failed", entry: "existing" },
  { status: "succeeded", entry: "existing" },
  { status: "running", entry: "started" },
] as const)(
  "keeps the $status report and exposes read recovery for a $entry run",
  async ({ status, entry }) => {
    const run = createUpdateRunFixture({
      status,
      phase: status === "running" ? "verifying" : "finished",
      finishedAtMs: status === "running" ? null : 4_000,
      reason: status === "failed" ? "build-failed" : null,
    });
    let admitted = entry === "existing";
    let rejectRunReads = false;
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        admitted = true;
        return { runId: run.runId };
      }
      if (method === "update.runs.get") {
        if (rejectRunReads) {
          throw new Error("Run status read failed");
        }
        return { run };
      }
      return method === "update.status" && admitted
        ? { [status === "running" ? "activeRun" : "lastRun"]: run }
        : {};
    });
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    let operation: Promise<void> | undefined;
    let settled: Promise<void> | undefined;
    try {
      await overlays.refreshUpdateStatus();
      settled = confirmAndStartUpdateRuntime({
        ...(entry === "existing" ? { existingRun: run } : {}),
        startGatewayUpdate: () => {
          operation = overlays.runUpdate();
        },
        onCheckStatus: () => overlays.refreshUpdateStatus(),
        watchUpdateProgress: createUpdateProgressWatcher({ gateway: harness.gateway, overlays }),
        updateAvailable: UPDATE_AVAILABLE,
        updateSchedule: null,
        viaNativeApp: false,
      });
      const { modal } = await getRenderedModalDialog(document.body);
      if (entry === "started") {
        findButton("Update and restart").click();
        await flushMicrotasks();
        await operation;
      }
      rejectRunReads = true;
      harness.emitEvent("update.run.changed", { ...run, updatedAtMs: run.updatedAtMs + 1 });
      await flushMicrotasks();
      const view = modal.querySelector<
        HTMLElement & { run: unknown; updateComplete: Promise<boolean> }
      >("openclaw-update-run-view")!;
      await view.updateComplete;
      expect(modal.textContent).toContain("Run status read failed");
      expect(view.run).toEqual(run);
      const check = findButton("Check status");
      expect(check.disabled).toBe(false);
      if (status === "running") {
        expect(
          [...modal.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Retry update",
          ),
        ).toBe(false);
      }
      check.click();
      await flushMicrotasks();
      expect(modal.textContent).not.toContain("Run status read failed");
      expect(view.run).toEqual(run);
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(
        entry === "started" ? 1 : 0,
      );
    } finally {
      document.body
        .querySelector("openclaw-modal-dialog")
        ?.dispatchEvent(new Event("modal-cancel"));
      await settled;
      await operation;
      overlays.dispose();
    }
  },
);
