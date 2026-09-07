const CHAT_ATTACHMENT_VIEWPORT_MARGIN = "240px 0px";

// Start bounded media work just before its card or image enters view so decoding
// stays offscreen until the operator is likely to need it.
export function observeChatAttachmentViewport(element: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver !== "function") {
    onVisible();
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      observer.disconnect();
      onVisible();
    },
    { rootMargin: CHAT_ATTACHMENT_VIEWPORT_MARGIN },
  );
  observer.observe(element);
  return () => observer.disconnect();
}

export function syncChatAttachmentRailScroll(element: Element | undefined): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const sync = () => {
    const scrollable = element.scrollWidth > element.clientWidth + 1;
    element.dataset.scrollable = String(scrollable);
    element.dataset.atStart = String(!scrollable || element.scrollLeft <= 1);
    element.dataset.atEnd = String(
      !scrollable || element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
    );
  };
  sync();
  requestAnimationFrame(sync);
}
