import type { Virtualizer } from "@tanstack/virtual-core";

export function resolveChatTranscriptInteractionRow(event: Event): HTMLElement | null {
  const target = event.target;
  const geometryControl =
    target instanceof Element
      ? target.closest("button[aria-expanded], button[aria-pressed], summary")
      : null;
  return geometryControl?.closest<HTMLElement>(".chat-virtual-row") ?? null;
}

export function reconcileChatTranscriptInteractionResize(
  row: HTMLElement | null,
  sidebarCommitTarget: EventTarget | null | undefined,
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  const sidebarRuntime = row?.closest(".sidebar-region__right-runtime");
  if (
    sidebarRuntime &&
    !(sidebarCommitTarget instanceof Element && sidebarCommitTarget.contains(row))
  ) {
    return false;
  }
  if (!row?.isConnected || !scrollElement?.contains(row)) {
    return true;
  }
  const index = virtualizer.indexFromElement(row);
  const options = virtualizer.options;
  // The clicked row is the interaction anchor. Measure its committed height
  // before paint without letting the transcript's ordinary end anchor compete.
  virtualizer.setOptions({ ...options, anchorTo: "start" });
  virtualizer.resizeItem(index, row.offsetHeight);
  virtualizer.setOptions(options);
  return true;
}
