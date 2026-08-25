const CHAT_ATTACHMENT_VIEWPORT_MARGIN = "240px 0px";

// Start bounded preview work just before the card enters view so decoded media
// is ready without doing attachment-body work for the whole transcript.
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
