import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { PresenceEntry } from "../../api/types.ts";
import type { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { clearChatModelSearchOnEscape } from "../chat/components/chat-model-picker.ts";

const PLACE_TOPOLOGY_EVENTS = new Set([
  "config.changed",
  "node.pair.requested",
  "node.pair.resolved",
  "node.runnerInventory.changed",
  "device.pair.requested",
  "device.pair.resolved",
]);

export function isPlaceTopologyEvent(event: string): boolean {
  return PLACE_TOPOLOGY_EVENTS.has(event);
}

export function presenceStateSignature(entries: PresenceEntry[]): string {
  const states = new Map<string, "connected" | "offline">();
  for (const entry of entries) {
    const id = (entry.deviceId ?? entry.instanceId)?.trim().toLowerCase();
    if (!id || entry.mode?.trim().toLowerCase() === "gateway") {
      continue;
    }
    states.set(id, entry.reason?.trim().toLowerCase() === "disconnect" ? "offline" : "connected");
  }
  return JSON.stringify([...states].toSorted(([left], [right]) => left.localeCompare(right)));
}

export function createControllerHost(element: OpenClawLightDomElement): ReactiveControllerHost {
  return {
    addController: (controller: ReactiveController) => element.addController(controller),
    removeController: (controller: ReactiveController) => element.removeController(controller),
    requestUpdate: () => element.requestUpdate(),
    get updateComplete() {
      return element.updateComplete;
    },
  };
}

export function closeAgentPicker(root: ParentNode) {
  const dropdown = root.querySelector<HTMLElement & { open: boolean }>(
    ".new-session-page__select--agent wa-dropdown",
  );
  if (dropdown) {
    dropdown.open = false;
  }
}

export function closeSessionMenus(root: ParentNode) {
  for (const selector of ["wa-dropdown[open]", "wa-popover.new-session-page__picker-popover"]) {
    for (const menu of root.querySelectorAll<HTMLElement & { open: boolean }>(selector)) {
      menu.open = false;
    }
  }
}

export function handleSessionPickerEvent(root: ParentNode, event: Event) {
  if (document.querySelector(".shell-nav[aria-modal='true']")) {
    return;
  }
  const pickers = root.querySelectorAll<HTMLDetailsElement>(".chat-controls__inline-select[open]");
  if (pickers.length === 0) {
    return;
  }
  if (event.type === "keydown") {
    const keyEvent = event as KeyboardEvent;
    clearChatModelSearchOnEscape(keyEvent);
    if (keyEvent.defaultPrevented || keyEvent.key !== "Escape") {
      return;
    }
    const picker =
      [...pickers].find((candidate) => event.composedPath().includes(candidate)) ?? pickers[0];
    if (!picker) {
      return;
    }
    const restoreFocus = event.composedPath().includes(picker);
    keyEvent.preventDefault();
    picker.open = false;
    if (restoreFocus) {
      picker.querySelector<HTMLElement>("summary")?.focus();
    }
    return;
  }
  for (const picker of pickers) {
    if (!event.composedPath().includes(picker)) {
      picker.open = false;
    }
  }
}
