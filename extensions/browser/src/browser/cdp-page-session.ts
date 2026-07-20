/**
 * CDP page-session preparation and committed-navigation observation.
 */
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { assertCdpEndpointAllowed, type CdpSendFn, withCdpSocket } from "./cdp.helpers.js";

/** HTTP and WebSocket timeout options for CDP actions that need discovery. */
export type CdpActionTimeouts = {
  httpTimeoutMs?: number;
  handshakeTimeoutMs?: number;
};

const CDP_TARGET_NAVIGATION_RESULT_TIMEOUT_MS = 2_000;
const CDP_TARGET_NAVIGATION_RESULT_POLL_MS = 50;
const CDP_TARGET_NAVIGATION_STABILITY_MS = 250;

type CdpFrameTreeResult = {
  frameTree?: {
    frame?: {
      loaderId?: unknown;
      unreachableUrl?: unknown;
      url?: unknown;
      urlFragment?: unknown;
    };
  };
};

function readCommittedFrameUrl(
  frame: NonNullable<CdpFrameTreeResult["frameTree"]>["frame"],
): string | undefined {
  const unreachableUrl =
    typeof frame?.unreachableUrl === "string" ? frame.unreachableUrl.trim() : "";
  if (unreachableUrl) {
    return unreachableUrl;
  }
  const url = typeof frame?.url === "string" ? frame.url.trim() : "";
  // Chrome reports ":" for the initial empty document before navigation commits.
  if (url === ":") {
    return undefined;
  }
  const fragment = typeof frame?.urlFragment === "string" ? frame.urlFragment.trim() : "";
  return url ? `${url}${fragment}` : undefined;
}

async function waitForCdpNavigationResult(
  send: CdpSendFn,
  sessionId: string | undefined,
  requestedUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + CDP_TARGET_NAVIGATION_RESULT_TIMEOUT_MS;
  const requestedAboutBlank = requestedUrl.trim() === "" || requestedUrl.trim() === "about:blank";
  let stableCandidate: { key: string; since: number } | undefined;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const frameTree = await send("Page.getFrameTree", undefined, sessionId).catch(() => null);
    signal?.throwIfAborted();
    const frame = (frameTree as CdpFrameTreeResult | null)?.frameTree?.frame;
    const finalUrl = readCommittedFrameUrl(frame);
    if (requestedAboutBlank && finalUrl === "about:blank") {
      return finalUrl;
    }
    const loaderId = typeof frame?.loaderId === "string" ? frame.loaderId.trim() : "";
    // Page.getFrameTree is browser-owned: its main frame URL and loader id
    // describe the currently committed document, not a provisional request or
    // page-overridable JavaScript value. A short stable window catches immediate
    // client redirects without waiting for slow subresources to finish loading.
    if (finalUrl && finalUrl !== "about:blank" && loaderId) {
      const key = `${loaderId}\n${finalUrl}`;
      const now = Date.now();
      if (stableCandidate?.key === key) {
        if (now - stableCandidate.since >= CDP_TARGET_NAVIGATION_STABILITY_MS) {
          return finalUrl;
        }
      } else {
        stableCandidate = { key, since: now };
      }
    } else {
      stableCandidate = undefined;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CDP_TARGET_NAVIGATION_RESULT_POLL_MS);
    });
  }
  return undefined;
}

/** Enable the page domains shared by target preparation and page operations. */
export async function prepareCdpPageSession(send: CdpSendFn, sessionId?: string): Promise<void> {
  await Promise.all([
    send("Page.enable", undefined, sessionId).catch(() => {}),
    send("Runtime.enable", undefined, sessionId).catch(() => {}),
    send("Network.enable", undefined, sessionId).catch(() => {}),
    send("DOM.enable", undefined, sessionId).catch(() => {}),
    send("Accessibility.enable", undefined, sessionId).catch(() => {}),
  ]);
  await send("Runtime.runIfWaitingForDebugger", undefined, sessionId).catch(() => {});
}

/** Prepare a created target and optionally observe its committed document URL. */
export async function prepareCdpTargetSession(
  send: CdpSendFn,
  targetId: string,
  navigationUrl?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const attached = (await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  }).catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
  if (!sessionId) {
    return undefined;
  }
  try {
    await prepareCdpPageSession(send, sessionId);
    return navigationUrl === undefined
      ? undefined
      : await waitForCdpNavigationResult(send, sessionId, navigationUrl, signal);
  } finally {
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

/** Read the committed document URL from a page-level CDP WebSocket. */
export async function waitForCdpCommittedNavigationUrl(opts: {
  wsUrl: string;
  configuredCdpUrl: string;
  cdpPolicy?: SsrFPolicy;
  requestedUrl: string;
  signal?: AbortSignal;
  timeouts?: CdpActionTimeouts;
}): Promise<string | undefined> {
  await assertCdpEndpointAllowed(opts.wsUrl, opts.cdpPolicy, {
    source: "discovered",
    configuredUrl: opts.configuredCdpUrl,
  });
  opts.signal?.throwIfAborted();
  try {
    return await withCdpSocket(
      opts.wsUrl,
      async (send) => {
        opts.signal?.throwIfAborted();
        await send("Page.enable");
        return await waitForCdpNavigationResult(send, undefined, opts.requestedUrl, opts.signal);
      },
      {
        commandTimeoutMs: opts.timeouts?.httpTimeoutMs ?? CDP_TARGET_NAVIGATION_RESULT_TIMEOUT_MS,
        handshakeTimeoutMs: opts.timeouts?.handshakeTimeoutMs,
        handshakeRetries: 0,
      },
    );
  } catch {
    opts.signal?.throwIfAborted();
    return undefined;
  }
}
