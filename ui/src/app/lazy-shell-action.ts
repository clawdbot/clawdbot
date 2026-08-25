import { COMMAND_PALETTE_OPEN_EVENT } from "../components/command-palette-contract.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { getSafeSessionStorage } from "../local-storage.ts";

const STORAGE_KEY = "openclaw:lazy-event";
export const SHELL_APPROVALS_OPEN_EVENT = "openclaw:approvals-open";
const eventTypes = [
  COMMAND_PALETTE_OPEN_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  BROWSER_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  SHELL_APPROVALS_OPEN_EVENT,
] as const;

export type LazyShellEvent = {
  eventType:
    | typeof COMMAND_PALETTE_OPEN_EVENT
    | typeof DEBUG_OVERLAY_REQUEST_EVENT
    | typeof KEYBOARD_SHORTCUTS_REQUEST_EVENT
    | typeof TERMINAL_PANEL_TOGGLE_EVENT
    | typeof BROWSER_PANEL_TOGGLE_EVENT
    | typeof DESKTOP_PANEL_TOGGLE_EVENT
    | typeof CUSTODIAN_PANEL_TOGGLE_EVENT
    | typeof SHELL_APPROVALS_OPEN_EVENT;
  detail?: object;
};

export function lazyShellEvent(
  eventType: LazyShellEvent["eventType"],
  event?: Event,
): LazyShellEvent {
  const detail = event instanceof CustomEvent ? event.detail : null;
  return detail !== null && typeof detail === "object" && !Array.isArray(detail)
    ? { eventType, detail }
    : { eventType };
}

export function hasStoredLazyShellAction(): boolean {
  try {
    return getSafeSessionStorage()?.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function readLazyShellAction(): LazyShellEvent | null {
  try {
    const stored = getSafeSessionStorage()?.getItem(STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      clearLazyShellAction();
      return null;
    }
    const entries = Object.entries(parsed);
    const eventTypeValue = entries.find(([key]) => key === "eventType")?.[1];
    const eventType = eventTypes.find((candidate) => candidate === eventTypeValue);
    if (eventType && entries.length === 1) {
      return { eventType };
    }
    const detail = entries.find(([key]) => key === "detail")?.[1];
    if (
      eventType &&
      entries.length === 2 &&
      detail !== null &&
      typeof detail === "object" &&
      !Array.isArray(detail)
    ) {
      return { eventType, detail };
    }
  } catch {}
  clearLazyShellAction();
  return null;
}

function writeStoredAction(value?: string): void {
  try {
    const storage = getSafeSessionStorage();
    if (value === undefined) {
      storage?.removeItem(STORAGE_KEY);
    } else {
      storage?.setItem(STORAGE_KEY, value);
    }
  } catch {}
}

export function persistLazyShellAction(event: LazyShellEvent): void {
  writeStoredAction(JSON.stringify(event));
}

export function clearLazyShellAction(): void {
  writeStoredAction();
}
