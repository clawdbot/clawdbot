import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";
import {
  SESSION_PROGRESS_HOVER_LINK_SELECTOR,
  sessionProgressHoverTargetFromEvent,
} from "./session-progress-hovercard-target.ts";
import type { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.ts";

const HOVERCARD_TAG = "openclaw-session-progress-hovercard-provider";

let bootstrapObserver: MutationObserver | null = null;

const bootstrap = new LazyHovercardBootstrap<SessionProgressHovercardProvider>({
  tag: HOVERCARD_TAG,
  load: async () =>
    (await import("./session-progress-hovercard.runtime.ts")).SessionProgressHovercardProvider,
  onDefined: () => {
    bootstrapObserver?.disconnect();
    bootstrapObserver = null;
  },
});

function handleBootstrapMutations(records: MutationRecord[]): void {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      if (
        node.matches(SESSION_PROGRESS_HOVER_LINK_SELECTOR) ||
        node.querySelector(SESSION_PROGRESS_HOVER_LINK_SELECTOR)
      ) {
        void bootstrap.define();
        return;
      }
    }
  }
}

async function activateHovercard(event: Event, trigger: HovercardBootstrapTrigger): Promise<void> {
  if (
    trigger === "pointer" &&
    ((event instanceof PointerEvent && event.pointerType === "touch") ||
      !globalThis.matchMedia?.("(hover: hover)").matches)
  ) {
    return;
  }
  const target = sessionProgressHoverTargetFromEvent(event);
  if (!target || !bootstrap.providerFor(target)) {
    return;
  }
  await bootstrap.define();
  const eventTarget = event.target;
  if (
    !(eventTarget instanceof EventTarget) ||
    !target.isConnected ||
    !hovercardBootstrapIntentActive(target, trigger, true)
  ) {
    return;
  }
  eventTarget.dispatchEvent(
    new Event(trigger === "pointer" ? "pointerover" : "focusin", {
      bubbles: true,
      composed: true,
    }),
  );
}

bootstrap.install(activateHovercard);
if (!customElements.get(HOVERCARD_TAG)) {
  bootstrapObserver = new MutationObserver(handleBootstrapMutations);
  bootstrapObserver.observe(document, { childList: true, subtree: true });
  if (document.querySelector(SESSION_PROGRESS_HOVER_LINK_SELECTOR)) {
    void bootstrap.define();
  }
}
