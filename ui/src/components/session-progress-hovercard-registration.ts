import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";
import {
  SESSION_PROGRESS_HOVER_TARGET_SELECTOR,
  sessionProgressHoverTargetFromEvent,
} from "./session-progress-hovercard-target.ts";

const HOVERCARD_TAG = "openclaw-session-progress-hovercard-provider";

let bootstrapObserver: MutationObserver | null = null;

type HovercardProviderElement = HTMLElement & {
  client?: GatewayBrowserClient | null;
  context?: ApplicationContext | null;
  gateway?: ApplicationGateway | null;
};

const bootstrap = new LazyHovercardBootstrap<
  HovercardProviderElement,
  {
    client: GatewayBrowserClient | null;
    context: ApplicationContext | null;
    gateway: ApplicationGateway | null;
  }
>({
  tag: HOVERCARD_TAG,
  load: async () =>
    (await import("./session-progress-hovercard.runtime.ts")).SessionProgressHovercardProvider,
  snapshot: (provider) => ({
    client: provider.client ?? null,
    context: provider.context ?? null,
    gateway: provider.gateway ?? null,
  }),
  restore: (provider, properties) => {
    // Lit assigns .gateway before upgrade. Remove the expando so the runtime
    // accessors can own the restored dependencies after definition.
    delete provider.client;
    delete provider.context;
    delete provider.gateway;
    provider.client = properties.client;
    provider.context = properties.context;
    provider.gateway = properties.gateway;
  },
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
        node.matches(SESSION_PROGRESS_HOVER_TARGET_SELECTOR) ||
        node.querySelector(SESSION_PROGRESS_HOVER_TARGET_SELECTOR)
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
  if (document.querySelector(SESSION_PROGRESS_HOVER_TARGET_SELECTOR)) {
    void bootstrap.define();
  }
}
