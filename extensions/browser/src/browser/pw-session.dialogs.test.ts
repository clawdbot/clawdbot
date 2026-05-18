import type { Dialog, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armObservedDialogResponseOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  getObservedBrowserStateForPage,
  isBrowserObservedDialogBlockedError,
  markObservedDialogsHandledRemotelyForPage,
  respondToObservedDialogOnPage,
} from "./pw-session.js";

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
