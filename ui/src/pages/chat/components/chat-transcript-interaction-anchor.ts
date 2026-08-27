import type { Virtualizer } from "@tanstack/virtual-core";

export type ChatTranscriptInteractionAnchor = {
  row: HTMLElement;
  top: number;
};

export function resolveChatTranscriptInteractionAnchor(
  event: Event,
): ChatTranscriptInteractionAnchor | null {
  const target = event.target;
  const geometryControl =
    target instanceof Element
      ? target.closest("button[aria-expanded], button[aria-pressed], summary")
      : null;
  const row = geometryControl?.closest<HTMLElement>(".chat-virtual-row");
  return row ? { row, top: row.getBoundingClientRect().top } : null;
}

export function reconcileChatTranscriptInteractionResize(
  anchor: ChatTranscriptInteractionAnchor | null,
  sidebarCommitTarget: EventTarget | null | undefined,
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  if (!anchor) {
    return true;
  }
  const row = anchor.row;
  const sidebarRuntime = row.closest(".sidebar-region__right-runtime");
  if (
    sidebarRuntime &&
    !(sidebarCommitTarget instanceof Element && sidebarCommitTarget.contains(row))
  ) {
    return false;
  }
  if (!row.isConnected || !scrollElement?.contains(row)) {
    return true;
  }
  const index = virtualizer.indexFromElement(row);
  const options = virtualizer.options;
  // The clicked row is the interaction anchor. Measure its committed height
  // before paint without letting the transcript's ordinary end anchor compete.
  virtualizer.setOptions({ ...options, anchorTo: "start" });
  virtualizer.resizeItem(index, row.offsetHeight);
  virtualizer.setOptions(options);
  scrollElement.scrollTop += row.getBoundingClientRect().top - anchor.top;
  return true;
}
