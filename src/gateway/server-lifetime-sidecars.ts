import type { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

type GatewayChatMetadataLifecycle = Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>;

export async function attachInitialGatewayLifetimeSidecars(params: {
  chatMetadataLifecycle: GatewayChatMetadataLifecycle;
  gatewayRequestContext: GatewayRequestContext;
  sidecars: GatewayPostReadySidecarHandle[];
}): Promise<void> {
  await params.chatMetadataLifecycle.attachContext(params.gatewayRequestContext, params.sidecars);
  params.sidecars.push({
    stop: async () => {
      const { flushPendingSessionsChangedEvents } =
        await import("./server-methods/session-change-event.js");
      flushPendingSessionsChangedEvents(params.gatewayRequestContext);
    },
  });
}

export function publishGatewayLifetimeSidecars(params: {
  registered: readonly GatewayPostReadySidecarHandle[];
  published: readonly GatewayPostReadySidecarHandle[];
  closeStarted: boolean;
  stopAfterCloseStarted: (params: {
    postReadySidecars: GatewayPostReadySidecarHandle[];
    closeStarted: boolean;
  }) => void;
}): GatewayPostReadySidecarHandle[] {
  const sidecars = [...new Set([...params.registered, ...params.published])];
  params.stopAfterCloseStarted({
    postReadySidecars: sidecars,
    closeStarted: params.closeStarted,
  });
  return params.closeStarted ? [] : sidecars;
}
