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

type HovercardProviderElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  context: ApplicationContext | null;
};

function providerForAnchor(anchor: HTMLAnchorElement): SessionLinkHovercardProvider | null {
  return anchor.closest<SessionLinkHovercardProvider>(HOVERCARD_TAG);
}

function removeBootstrapListeners(): void {
  document.removeEventListener("pointerover", handleBootstrapPointerOver, true);
  document.removeEventListener("focusin", handleBootstrapFocusIn, true);
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
  removeBootstrapListeners();
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
  removeBootstrapListeners();
} else {
  document.addEventListener("pointerover", handleBootstrapPointerOver, true);
  document.addEventListener("focusin", handleBootstrapFocusIn, true);
}
