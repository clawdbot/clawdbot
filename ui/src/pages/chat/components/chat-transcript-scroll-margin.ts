import type { Virtualizer } from "@tanstack/virtual-core";
import type { ReactiveControllerHost } from "lit";

function transcriptScrollMargin(element: Element | null): number {
  if (!(element instanceof HTMLElement) || typeof getComputedStyle !== "function") {
    return 0;
  }
  const margin = Number.parseFloat(getComputedStyle(element).paddingTop);
  return Number.isFinite(margin) ? margin : 0;
}

export function initialScrollMargin(host: ReactiveControllerHost): number {
  return host instanceof HTMLElement
    ? transcriptScrollMargin(host.querySelector(".chat-thread"))
    : 0;
}

export function syncScrollMargin(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): void {
  const scrollMargin = transcriptScrollMargin(scrollElement);
  if (scrollMargin === virtualizer.options.scrollMargin) {
    return;
  }
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin,
  });
}
