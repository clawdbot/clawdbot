import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { isFutureDateTimestampMs, parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Dialog } from "playwright-core";
import type {
  BrowserObservedDialogRecord,
  BrowserObservedState,
  PageState,
  PendingObservedDialog,
} from "./pw-session-contracts.js";
import {
  BrowserObservedDialogBlockedError,
  OBSERVED_DIALOG_TIMEOUT_MS,
  MAX_RECENT_DIALOGS,
} from "./pw-session-contracts.js";

export function resolveObservedDialogTimeoutMs(timeoutMs: number | undefined): number {
  const parsed = parseFiniteNumber(timeoutMs);
  return Math.max(1, Math.floor(parsed ?? OBSERVED_DIALOG_TIMEOUT_MS));
}

export function appendRecentDialog(state: PageState, record: BrowserObservedDialogRecord): void {
  state.recentDialogs.push(record);
  while (state.recentDialogs.length > MAX_RECENT_DIALOGS) {
    state.recentDialogs.shift();
  }
}

function serializeDialogRecord(dialog: BrowserObservedDialogRecord): BrowserObservedDialogRecord {
  return {
    id: dialog.id,
    type: dialog.type,
    message: dialog.message,
    ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}),
    openedAt: dialog.openedAt,
    ...(dialog.closedAt !== undefined ? { closedAt: dialog.closedAt } : {}),
    ...(dialog.closedBy !== undefined ? { closedBy: dialog.closedBy } : {}),
  };
}

function serializePendingDialog(dialog: PendingObservedDialog): BrowserObservedDialogRecord {
  return serializeDialogRecord(dialog);
}

export function serializeObservedBrowserState(state: PageState): BrowserObservedState {
  return {
    dialogs: {
      pending: state.pendingDialogs.map(serializePendingDialog),
      recent: state.recentDialogs.map(serializeDialogRecord),
    },
  };
}

export function clearArmedDialogResponse(state: PageState): void {
  if (state.armedDialogResponse?.timer) {
    clearTimeout(state.armedDialogResponse.timer);
  }
  state.armedDialogResponse = undefined;
}

function abortActionsBlockedByDialog(state: PageState): void {
  if (state.dialogAbortControllers.size === 0) {
    return;
  }
  const err = new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state));
  for (const controller of state.dialogAbortControllers) {
    if (!controller.signal.aborted) {
      controller.abort(err);
    }
  }
  state.dialogAbortControllers.clear();
}

function isNoDialogShowingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("no dialog is showing");
}

export async function settleObservedDialog(params: {
  state: PageState;
  pending: PendingObservedDialog;
  accept: boolean;
  promptText?: string;
  closedBy: NonNullable<BrowserObservedDialogRecord["closedBy"]>;
}): Promise<BrowserObservedDialogRecord> {
  const { state, pending } = params;
  state.pendingDialogs = state.pendingDialogs.filter((dialog) => dialog.id !== pending.id);

  let closedBy = params.closedBy;
  try {
    if (params.accept) {
      await pending.dialog.accept(params.promptText);
    } else {
      await pending.dialog.dismiss();
    }
  } catch (err) {
    if (!isNoDialogShowingError(err)) {
      if (params.closedBy === "agent") {
        state.pendingDialogs.push(pending);
      }
      throw err;
    }
    closedBy = "remote";
  }

  const record: BrowserObservedDialogRecord = {
    id: pending.id,
    type: pending.type,
    message: pending.message,
    ...(pending.defaultValue !== undefined ? { defaultValue: pending.defaultValue } : {}),
    openedAt: pending.openedAt,
    closedAt: new Date().toISOString(),
    closedBy,
  };
  appendRecentDialog(state, record);
  return record;
}

export function observeDialog(pageState: PageState, dialog: Dialog): void {
  pageState.nextObservedDialogId += 1;
  const type = dialog.type();
  const defaultValue = dialog.defaultValue();
  const pending: PendingObservedDialog = {
    id: `d${pageState.nextObservedDialogId}`,
    type,
    message: dialog.message(),
    openedAt: new Date().toISOString(),
    dialog,
    ...(type === "prompt" ? { defaultValue } : {}),
  };
  pageState.pendingDialogs.push(pending);

  const armed = pageState.armedDialogResponse;
  if (armed && isFutureDateTimestampMs(armed.expiresAt)) {
    clearArmedDialogResponse(pageState);
    void settleObservedDialog({
      state: pageState,
      pending,
      accept: armed.accept,
      ...(armed.promptText !== undefined ? { promptText: armed.promptText } : {}),
      closedBy: "armed",
    }).catch(() => {});
    return;
  }
  if (armed) {
    clearArmedDialogResponse(pageState);
  }
  abortActionsBlockedByDialog(pageState);
}

export function resolvePendingDialogForResponse(params: {
  state: PageState;
  dialogId?: string;
}): PendingObservedDialog {
  const dialogId = normalizeOptionalString(params.dialogId);
  if (dialogId) {
    const found = params.state.pendingDialogs.find((dialog) => dialog.id === dialogId);
    if (found) {
      return found;
    }
    throw new Error(`Dialog "${dialogId}" is not pending.`);
  }
  if (params.state.pendingDialogs.length === 1) {
    return expectDefined(params.state.pendingDialogs.at(0), "single pending browser dialog");
  }
  if (params.state.pendingDialogs.length > 1) {
    throw new Error("Multiple dialogs are pending; pass dialogId.");
  }
  throw new Error("No dialog is pending.");
}

/** Respond to a pending observed dialog on a page. */
