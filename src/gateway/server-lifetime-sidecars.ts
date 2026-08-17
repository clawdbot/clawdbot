import type { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

type GatewayChatMetadataLifecycle = Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>;

export async function attachInitialGatewayLifetimeSidecars(params: {
  chatMetadataLifecycle: GatewayChatMetadataLifecycle;
  gatewayRequestContext: GatewayRequestContext;
  flushPendingSessionsChangedEvents: (context?: object) => void;
  sidecars: GatewayPostReadySidecarHandle[];
}): Promise<void> {
  await params.chatMetadataLifecycle.attachContext(params.gatewayRequestContext, params.sidecars);
  params.sidecars.push({
    stop: () => {
      params.flushPendingSessionsChangedEvents(params.gatewayRequestContext);
    },
  });
}
