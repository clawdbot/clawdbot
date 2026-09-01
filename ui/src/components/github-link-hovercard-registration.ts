import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GitHubLinkHovercardProvider } from "./github-link-hovercard.runtime.ts";
import {
  GITHUB_HOVERCARD_OPEN_DELAY_MS,
  githubLinkAnchorFromEvent,
  parseGitHubLinkTarget,
} from "./github-link-target.ts";
import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  remainingHovercardOpenDelay,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";

const HOVERCARD_TAG = "openclaw-github-link-hovercard-provider";

type HovercardProviderElement = GitHubLinkHovercardProvider;

const bootstrap = new LazyHovercardBootstrap<HovercardProviderElement, GatewayBrowserClient | null>(
  {
    tag: HOVERCARD_TAG,
    load: async () =>
      (await import("./github-link-hovercard.runtime.ts")).GitHubLinkHovercardProvider,
    snapshot: (provider) => provider.client,
    restore: (provider, client) => {
      provider.client = client;
    },
  },
);

async function activateHovercard(event: Event, trigger: HovercardBootstrapTrigger): Promise<void> {
  if (trigger === "pointer" && (event as PointerEvent).pointerType === "touch") {
    return;
  }
  const anchor = githubLinkAnchorFromEvent(event);
  const target = anchor ? parseGitHubLinkTarget(anchor.href) : null;
  if (!anchor || !target || !bootstrap.providerFor(anchor)) {
    return;
  }
  const startedAt = performance.now();
  await bootstrap.define();
  const provider = bootstrap.providerFor(anchor);
  if (!provider || !anchor.isConnected || !hovercardBootstrapIntentActive(anchor, trigger)) {
    return;
  }
  const delay =
    trigger === "pointer"
      ? remainingHovercardOpenDelay(startedAt, GITHUB_HOVERCARD_OPEN_DELAY_MS)
      : 0;
  provider.activateFromBootstrap(anchor, target, trigger, delay);
}

bootstrap.install(activateHovercard);
