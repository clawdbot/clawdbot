// Browser tests cover pw sessionialogs plugin behavior.
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import type { Dialog, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pwAi } from "./pw-ai.js";
import { armObservedDialogResponseOnPage } from "./pw-session.js";

const {
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  getObservedBrowserStateForPage,
  isBrowserObservedDialogBlockedError,
  markObservedDialogsHandledRemotelyForPage,
  respondToObservedDialogOnPage,
} = pwAi;

type Handler = (arg: unknown) => void;

function createPageHarness() {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return page;
    },
  };
  return {
    page: page as unknown as Page,
    emit: (event: string, arg: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(arg);
      }
    },
  };
}

function createDialog(
  overrides: Partial<{
    type: string;
    message: string;
    defaultValue: string;
  }> = {},
) {
  return {
    type: vi.fn(() => overrides.type ?? "confirm"),
    message: vi.fn(() => overrides.message ?? "Continue?"),
    defaultValue: vi.fn(() => overrides.defaultValue ?? ""),
    accept: vi.fn(async (_promptText?: string) => {}),
    dismiss: vi.fn(async () => {}),
  } as unknown as Dialog & {
    accept: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
  };
}

describe("observed browser dialogs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces pending dialogs and lets callers respond by id", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ message: "Ship it?" });

    emit("dialog", dialog);

    expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
      { id: "d1", type: "confirm", message: "Ship it?" },
    ]);

    const closed = await respondToObservedDialogOnPage({
      page,
      dialogId: "d1",
      accept: true,
      promptText: "yes",
    });

    expect(dialog.accept).toHaveBeenCalledWith("yes");
    expect(closed.closedBy).toBe("agent");
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", closedBy: "agent" },
    ]);
  });

  it("keeps arm-next-dialog behavior through the observed dialog path", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ type: "alert", message: "Heads up" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
    emit("dialog", dialog);
    await Promise.resolve();

    expect(observed.signal.aborted).toBe(false);
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", type: "alert", closedBy: "armed" },
    ]);
    observed.cleanup();
  });

  it.each([true, false])(
    "aborts every in-flight action with the original armed dialog failure (accept: %s)",
    async (accept) => {
      const { page, emit } = createPageHarness();
      ensurePageState(page);
      const dialog = createDialog();
      const failure = new Error("Browser dialog response failed");
      dialog[accept ? "accept" : "dismiss"].mockRejectedValue(failure);
      const first = createObservedDialogAbortSignalForPage({ page });
      const second = createObservedDialogAbortSignalForPage({ page });

      armObservedDialogResponseOnPage({ page, accept, timeoutMs: 1000 });
      emit("dialog", dialog);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(first.signal.reason).toBe(failure);
      expect(second.signal.reason).toBe(failure);
      expect(getObservedBrowserStateForPage(page).dialogs).toEqual({ pending: [], recent: [] });
      first.cleanup();
      second.cleanup();
    },
  );

  it.each([true, false])(
    "does not requeue a consumed dialog when an explicit response fails (accept: %s)",
    async (accept) => {
      const { page, emit } = createPageHarness();
      ensurePageState(page);
      const dialog = createDialog();
      const failure = new Error("Browser dialog response failed");
      dialog[accept ? "accept" : "dismiss"].mockRejectedValue(failure);
      emit("dialog", dialog);

      await expect(respondToObservedDialogOnPage({ page, dialogId: "d1", accept })).rejects.toBe(
        failure,
      );

      expect(getObservedBrowserStateForPage(page).dialogs).toEqual({ pending: [], recent: [] });
      await expect(respondToObservedDialogOnPage({ page, dialogId: "d1", accept })).rejects.toThrow(
        'Dialog "d1" is not pending.',
      );
    },
  );

  it.each([true, false])(
    "records an already-closed dialog as remotely handled (accept: %s)",
    async (accept) => {
      const { page, emit } = createPageHarness();
      ensurePageState(page);
      const dialog = createDialog();
      dialog[accept ? "accept" : "dismiss"].mockRejectedValue(
        new Error("Protocol error: No dialog is showing"),
      );
      emit("dialog", dialog);

      const closed = await respondToObservedDialogOnPage({ page, dialogId: "d1", accept });

      expect(closed.closedBy).toBe("remote");
      expect(getObservedBrowserStateForPage(page).dialogs).toMatchObject({
        pending: [],
        recent: [{ id: "d1", closedBy: "remote" }],
      });
    },
  );

  it("uses the default arm-next-dialog timeout for non-finite timeoutMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ type: "alert", message: "Still armed" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: Number.NaN });
    await vi.advanceTimersByTimeAsync(119_999);
    emit("dialog", dialog);
    await Promise.resolve();

    expect(observed.signal.aborted).toBe(false);
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", type: "alert", closedBy: "armed" },
    ]);
    observed.cleanup();
  });

  it("does not arm next-dialog responses while the process clock is invalid", () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Number.NaN);
      const { page, emit } = createPageHarness();
      ensurePageState(page);
      const dialog = createDialog({ type: "alert", message: "Still pending" });

      armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
      emit("dialog", dialog);

      expect(dialog.dismiss).not.toHaveBeenCalled();
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
        { id: "d1", type: "alert", message: "Still pending" },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not arm next-dialog responses when the expiry would overflow Date bounds", () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);
      const { page, emit } = createPageHarness();
      ensurePageState(page);
      const dialog = createDialog({ type: "alert", message: "Still pending" });

      armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
      emit("dialog", dialog);

      expect(dialog.dismiss).not.toHaveBeenCalled();
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
        { id: "d1", type: "alert", message: "Still pending" },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("aborts in-flight actions while keeping unarmed dialogs pending", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ type: "alert", message: "Heads up" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    emit("dialog", dialog);

    expect(observed.signal.aborted).toBe(true);
    expect(isBrowserObservedDialogBlockedError(observed.signal.reason)).toBe(true);
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
      { id: "d1", type: "alert", message: "Heads up" },
    ]);

    expect(dialog.dismiss).not.toHaveBeenCalled();
    await respondToObservedDialogOnPage({ page, dialogId: "d1", accept: false });
    observed.cleanup();

    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", type: "alert", closedBy: "agent" },
    ]);
  });

  it("moves remotely handled pending dialogs into recent state", () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    emit("dialog", createDialog({ type: "confirm", message: "Continue?" }));

    const state = markObservedDialogsHandledRemotelyForPage(page);

    expect(state.dialogs.pending).toEqual([]);
    expect(state.dialogs.recent).toMatchObject([
      { id: "d1", type: "confirm", message: "Continue?", closedBy: "remote" },
    ]);
  });
});
