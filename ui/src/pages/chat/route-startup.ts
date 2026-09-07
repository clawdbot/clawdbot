import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import type { SessionRouteContext } from "./route-loader-context.ts";

type StartupHandoff = {
  result?: ChatHistoryResult;
  sessionKey?: string;
  isCurrent: () => boolean;
  dispose: () => void;
};

const startupHandoffs = new WeakMap<GatewayBrowserClient, StartupHandoff>();

export function prepareChatRouteStartup(
  {
    gateway,
    router,
    lifecycleAbortSignal,
  }: Pick<SessionRouteContext, "gateway" | "router" | "lifecycleAbortSignal">,
  signal: AbortSignal,
): { store: (sessionKey: string, result: ChatHistoryResult) => void; dispose: () => void } {
  const { client, hello } = gateway.snapshot;
  if (!client) {
    throw new Error("Chat startup requires a connected Gateway");
  }
  startupHandoffs.get(client)?.dispose();
  const cleanups: Array<() => void> = [];
  let disposed = false;
  const handoff: StartupHandoff = {
    isCurrent: () => {
      const route = router.getState();
      const match = route.pendingMatches[0] ?? route.matches[0];
      return (
        !signal.aborted &&
        !lifecycleAbortSignal?.aborted &&
        gateway.snapshot.phase === "connected" &&
        gateway.snapshot.client === client &&
        gateway.snapshot.hello === hello &&
        match?.abortController.signal === signal &&
        match.error === undefined
      );
    },
    dispose: () => {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      signal.removeEventListener("abort", handoff.dispose);
      lifecycleAbortSignal?.removeEventListener("abort", handoff.dispose);
      if (startupHandoffs.get(client) === handoff) {
        startupHandoffs.delete(client);
      }
    },
  };
  startupHandoffs.set(client, handoff);
  const retainCleanup = (cleanup: () => void) => {
    if (disposed) {
      cleanup();
    } else {
      cleanups.push(cleanup);
    }
  };
  const checkOwner = () => {
    if (!handoff.isCurrent()) {
      handoff.dispose();
    }
  };
  // The route reads before the pane subscribes. Any intervening session event
  // invalidates the handoff so the pane's normal history owner closes that gap.
  retainCleanup(
    gateway.subscribeEvents((event) => {
      if (event.event === "chat" || event.event === "agent" || event.event.startsWith("session")) {
        handoff.dispose();
      }
    }),
  );
  // The loader signal only covers pending work. Its exact router match owns
  // completed work until the pane mounts, the route changes, or the outlet fails.
  retainCleanup(router.subscribe(checkOwner));
  retainCleanup(gateway.subscribe(checkOwner));
  signal.addEventListener("abort", handoff.dispose, { once: true });
  lifecycleAbortSignal?.addEventListener("abort", handoff.dispose, { once: true });
  checkOwner();
  return {
    dispose: handoff.dispose,
    store: (sessionKey, result) => {
      if (startupHandoffs.get(client) === handoff && handoff.isCurrent()) {
        handoff.sessionKey = sessionKey;
        handoff.result = result;
      } else {
        handoff.dispose();
      }
    },
  };
}

export function consumeChatRouteStartup(
  client: GatewayBrowserClient,
  sessionKey: string,
): ChatHistoryResult | undefined {
  const handoff = startupHandoffs.get(client);
  if (!handoff) {
    return undefined;
  }
  if (!handoff.isCurrent()) {
    handoff.dispose();
    return undefined;
  }
  if (handoff.sessionKey !== sessionKey) {
    return undefined;
  }
  handoff.dispose();
  return handoff.result;
}
