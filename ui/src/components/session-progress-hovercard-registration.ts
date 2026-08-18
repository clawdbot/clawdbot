import type { ApplicationGateway } from "../app/gateway.ts";
import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";

const HOVERCARD_TAG = "openclaw-session-progress-hovercard-provider";

type HovercardProviderElement = HTMLElement & { gateway?: ApplicationGateway | null };

const bootstrap = new LazyHovercardBootstrap<HovercardProviderElement, ApplicationGateway | null>({
  tag: HOVERCARD_TAG,
  load: async () =>
    (await import("./session-progress-hovercard.runtime.ts")).SessionProgressHovercardProvider,
  snapshot: (provider) => provider.gateway ?? null,
  restore: (provider, gateway) => {
    // Lit assigns .gateway before upgrade. Remove the expando so the runtime
    // accessor can own store subscriptions after definition.
    delete provider.gateway;
    provider.gateway = gateway;
  },
});

function sessionRowFromEvent(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLElement && target.dataset.sessionKey) {
      return target;
    }
  }
  return null;
}

async function activateHovercard(event: Event, trigger: HovercardBootstrapTrigger): Promise<void> {
  if (
    trigger === "pointer" &&
    ((event instanceof PointerEvent && event.pointerType === "touch") ||
      !globalThis.matchMedia?.("(hover: hover)").matches)
  ) {
    return;
  }
  const row = sessionRowFromEvent(event);
  if (!row || !bootstrap.providerFor(row)) {
    return;
  }
  await bootstrap.define();
  const target = event.target;
  if (
    !(target instanceof EventTarget) ||
    !row.isConnected ||
    !hovercardBootstrapIntentActive(row, trigger, true)
  ) {
    return;
  }
  target.dispatchEvent(
    new Event(trigger === "pointer" ? "pointerover" : "focusin", {
      bubbles: true,
      composed: true,
    }),
  );
}

bootstrap.install(activateHovercard);
