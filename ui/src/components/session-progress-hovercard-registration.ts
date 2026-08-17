import type { ApplicationGateway } from "../app/gateway.ts";
import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";

const HOVERCARD_TAG = "openclaw-session-progress-hovercard-provider";

type HovercardProviderElement = HTMLElement & { gateway?: ApplicationGateway | null };

function sessionRowFromEvent(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLElement && target.dataset.sessionKey) {
      return target;
    }
  }
  return null;
}

function providerForRow(row: HTMLElement): HovercardProviderElement | null {
  return row.closest<HovercardProviderElement>(HOVERCARD_TAG);
}

function removeBootstrapListeners(): void {
  document.removeEventListener("pointerover", handleBootstrapIntent, true);
  document.removeEventListener("focusin", handleBootstrapIntent, true);
}

async function activateHovercard(event: Event): Promise<void> {
  if (
    event.type === "pointerover" &&
    ((event instanceof PointerEvent && event.pointerType === "touch") ||
      !globalThis.matchMedia?.("(hover: hover)").matches)
  ) {
    return;
  }
  const row = sessionRowFromEvent(event);
  if (!row || !providerForRow(row)) {
    return;
  }
  const pendingGateways = new Map(
    [...document.querySelectorAll<HovercardProviderElement>(HOVERCARD_TAG)].map((provider) => [
      provider,
      provider.gateway ?? null,
    ]),
  );
  await ensureCustomElementDefined(HOVERCARD_TAG, async () => {
    const runtime = await import("./session-progress-hovercard.runtime.ts");
    if (!customElements.get(HOVERCARD_TAG)) {
      customElements.define(HOVERCARD_TAG, runtime.SessionProgressHovercardProvider);
    }
    for (const [provider, gateway] of pendingGateways) {
      // Lit assigns .gateway before the lazy element is defined. Remove that
      // expando after upgrade so the runtime accessor can own subscriptions.
      delete provider.gateway;
      provider.gateway = gateway;
    }
  });
  removeBootstrapListeners();
  const target = event.target;
  const stillActive =
    event.type === "pointerover"
      ? row.matches(":hover")
      : document.activeElement instanceof Node && row.contains(document.activeElement);
  if (!(target instanceof EventTarget) || !row.isConnected || !stillActive) {
    return;
  }
  target.dispatchEvent(
    new Event(event.type === "pointerover" ? "pointerover" : "focusin", {
      bubbles: true,
      composed: true,
    }),
  );
}

function handleBootstrapIntent(event: Event): void {
  void activateHovercard(event);
}

if (customElements.get(HOVERCARD_TAG)) {
  removeBootstrapListeners();
} else {
  document.addEventListener("pointerover", handleBootstrapIntent, true);
  document.addEventListener("focusin", handleBootstrapIntent, true);
}
