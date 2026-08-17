import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";
import {
  isPotentialSessionLink,
  SESSION_HOVERCARD_OPEN_DELAY_MS,
  sessionLinkAnchorFromEvent,
} from "./session-link-hovercard-target.ts";
import type { SessionLinkHovercardProvider } from "./session-link-hovercard.runtime.ts";

const HOVERCARD_TAG = "openclaw-session-link-hovercard-provider";
const SESSION_LINK_SELECTOR = "a.markdown-session-link";

let bootstrapObserver: MutationObserver | null = null;

type HovercardProviderElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  context: ApplicationContext | null;
};

function providerForAnchor(anchor: HTMLAnchorElement): SessionLinkHovercardProvider | null {
  return anchor.closest<SessionLinkHovercardProvider>(HOVERCARD_TAG);
}

function removeBootstrapActivation(): void {
  document.removeEventListener("pointerover", handleBootstrapPointerOver, true);
  document.removeEventListener("focusin", handleBootstrapFocusIn, true);
  bootstrapObserver?.disconnect();
  bootstrapObserver = null;
}

async function defineProvider(): Promise<void> {
  const pendingProviders = new Map(
    [...document.querySelectorAll<HovercardProviderElement>(HOVERCARD_TAG)].map((provider) => [
      provider,
      { client: provider.client, context: provider.context },
    ]),
  );
  await ensureCustomElementDefined(HOVERCARD_TAG, async () => {
    const runtime = await import("./session-link-hovercard.runtime.ts");
    if (!customElements.get(HOVERCARD_TAG)) {
      customElements.define(HOVERCARD_TAG, runtime.SessionLinkHovercardProvider);
    }
    for (const [provider, properties] of pendingProviders) {
      provider.client = properties.client;
      provider.context = properties.context;
    }
  });
  removeBootstrapActivation();
}

function handleBootstrapMutations(records: MutationRecord[]): void {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      if (node.matches(SESSION_LINK_SELECTOR) || node.querySelector(SESSION_LINK_SELECTOR)) {
        void defineProvider();
        return;
      }
    }
  }
}

async function activateHovercard(event: Event, trigger: "focus" | "pointer"): Promise<void> {
  if (trigger === "pointer" && "pointerType" in event && event.pointerType === "touch") {
    return;
  }
  const anchor = sessionLinkAnchorFromEvent(event);
  const provider = anchor ? providerForAnchor(anchor) : null;
  if (!anchor || !provider || !isPotentialSessionLink(anchor, provider.context?.basePath)) {
    return;
  }
  const startedAt = performance.now();
  await defineProvider();
  const upgraded = providerForAnchor(anchor);
  const stillActive =
    trigger === "pointer" ? anchor.matches(":hover") : document.activeElement === anchor;
  if (!upgraded || !anchor.isConnected || !stillActive) {
    return;
  }
  const delay =
    trigger === "pointer"
      ? Math.max(0, SESSION_HOVERCARD_OPEN_DELAY_MS - (performance.now() - startedAt))
      : 0;
  upgraded.activateFromBootstrap(anchor, trigger, delay);
}

function handleBootstrapPointerOver(event: Event): void {
  void activateHovercard(event, "pointer");
}

function handleBootstrapFocusIn(event: Event): void {
  void activateHovercard(event, "focus");
}

if (customElements.get(HOVERCARD_TAG)) {
  removeBootstrapActivation();
} else {
  document.addEventListener("pointerover", handleBootstrapPointerOver, true);
  document.addEventListener("focusin", handleBootstrapFocusIn, true);
  bootstrapObserver = new MutationObserver(handleBootstrapMutations);
  bootstrapObserver.observe(document, { childList: true, subtree: true });
  if (document.querySelector(SESSION_LINK_SELECTOR)) {
    void defineProvider();
  }
}
