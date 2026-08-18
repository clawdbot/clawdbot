import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  remainingHovercardOpenDelay,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";
import {
  isPotentialSessionLink,
  SESSION_HOVERCARD_OPEN_DELAY_MS,
  sessionLinkAnchorFromEvent,
} from "./session-link-hovercard-target.ts";
import type { SessionLinkHovercardProvider } from "./session-link-hovercard.runtime.ts";

const HOVERCARD_TAG = "openclaw-session-link-hovercard-provider";
const SESSION_LINK_SELECTOR = "a.markdown-session-link";

let bootstrapObserver: MutationObserver | null = null;

type HovercardProviderElement = SessionLinkHovercardProvider;

const bootstrap = new LazyHovercardBootstrap<
  HovercardProviderElement,
  { client: GatewayBrowserClient | null; context: ApplicationContext | null }
>({
  tag: HOVERCARD_TAG,
  load: async () =>
    (await import("./session-link-hovercard.runtime.ts")).SessionLinkHovercardProvider,
  snapshot: (provider) => ({ client: provider.client, context: provider.context }),
  restore: (provider, properties) => {
    provider.client = properties.client;
    provider.context = properties.context;
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
      if (node.matches(SESSION_LINK_SELECTOR) || node.querySelector(SESSION_LINK_SELECTOR)) {
        void bootstrap.define();
        return;
      }
    }
  }
}

async function activateHovercard(event: Event, trigger: HovercardBootstrapTrigger): Promise<void> {
  if (trigger === "pointer" && "pointerType" in event && event.pointerType === "touch") {
    return;
  }
  const anchor = sessionLinkAnchorFromEvent(event);
  const provider = anchor ? bootstrap.providerFor(anchor) : null;
  if (!anchor || !provider || !isPotentialSessionLink(anchor, provider.context?.basePath)) {
    return;
  }
  const startedAt = performance.now();
  await bootstrap.define();
  const upgraded = bootstrap.providerFor(anchor);
  if (!upgraded || !anchor.isConnected || !hovercardBootstrapIntentActive(anchor, trigger)) {
    return;
  }
  const delay =
    trigger === "pointer"
      ? remainingHovercardOpenDelay(startedAt, SESSION_HOVERCARD_OPEN_DELAY_MS)
      : 0;
  upgraded.activateFromBootstrap(anchor, trigger, delay);
}

bootstrap.install(activateHovercard);
if (!customElements.get(HOVERCARD_TAG)) {
  bootstrapObserver = new MutationObserver(handleBootstrapMutations);
  bootstrapObserver.observe(document, { childList: true, subtree: true });
  if (document.querySelector(SESSION_LINK_SELECTOR)) {
    void bootstrap.define();
  }
}
