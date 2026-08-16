import type { GatewayBrowserClient } from "../api/gateway.ts";
import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";
import type { GitHubLinkHovercardProvider } from "./github-link-hovercard.runtime.ts";
import {
  GITHUB_HOVERCARD_OPEN_DELAY_MS,
  githubLinkAnchorFromEvent,
  parseGitHubLinkTarget,
} from "./github-link-target.ts";

const HOVERCARD_TAG = "openclaw-github-link-hovercard-provider";

type HovercardProviderElement = HTMLElement & {
  client: GatewayBrowserClient | null;
};

function providerForAnchor(anchor: HTMLAnchorElement): GitHubLinkHovercardProvider | null {
  return anchor.closest<GitHubLinkHovercardProvider>(HOVERCARD_TAG);
}

function removeBootstrapListeners(): void {
  document.removeEventListener("pointerover", handleBootstrapPointerOver, true);
  document.removeEventListener("focusin", handleBootstrapFocusIn, true);
}

async function activateHovercard(event: Event, trigger: "focus" | "pointer"): Promise<void> {
  if (trigger === "pointer" && (event as PointerEvent).pointerType === "touch") {
    return;
  }
  const anchor = githubLinkAnchorFromEvent(event);
  const target = anchor ? parseGitHubLinkTarget(anchor.href) : null;
  if (!anchor || !target || !providerForAnchor(anchor)) {
    return;
  }
  const startedAt = performance.now();
  const pendingClients = new Map(
    [...document.querySelectorAll<HovercardProviderElement>(HOVERCARD_TAG)].map((provider) => [
      provider,
      provider.client,
    ]),
  );
  await ensureCustomElementDefined(HOVERCARD_TAG, async () => {
    const runtime = await import("./github-link-hovercard.runtime.ts");
    // Sibling module instances can share one document + registry (the
    // non-isolated jsdom lane evaluates this module once per test file), so a
    // concurrent instance may have defined the tag while our load resolved.
    if (!customElements.get(HOVERCARD_TAG)) {
      customElements.define(HOVERCARD_TAG, runtime.GitHubLinkHovercardProvider);
    }
    for (const [provider, client] of pendingClients) {
      provider.client = client;
    }
  });
  removeBootstrapListeners();
  const provider = providerForAnchor(anchor);
  const stillActive =
    trigger === "pointer" ? anchor.matches(":hover") : document.activeElement === anchor;
  if (!provider || !anchor.isConnected || !stillActive) {
    return;
  }
  const delay =
    trigger === "pointer"
      ? Math.max(0, GITHUB_HOVERCARD_OPEN_DELAY_MS - (performance.now() - startedAt))
      : 0;
  provider.activateFromBootstrap(anchor, target, trigger, delay);
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
