import { purgeExpiredSecretStoreEntries } from "../secrets/store/secret-store.js";
import type { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

type GatewayChatMetadataLifecycle = Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>;
const SECRET_STORE_EXPIRY_INTERVAL_MS = 60_000;

function startSecretStoreExpiryMaintenance(
  logWarning: (message: string) => void,
): GatewayPostReadySidecarHandle {
  let warned = false;
  const purge = () => {
    try {
      purgeExpiredSecretStoreEntries();
      warned = false;
    } catch {
      if (!warned) {
        logWarning("Secret store expiry cleanup failed; will retry.");
        warned = true;
      }
    }
  };
  purge();
  const interval = setInterval(purge, SECRET_STORE_EXPIRY_INTERVAL_MS);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}

export async function attachInitialGatewayLifetimeSidecars(params: {
  chatMetadataLifecycle: GatewayChatMetadataLifecycle;
  gatewayRequestContext: GatewayRequestContext;
  flushPendingSessionsChangedEvents: (context?: object) => void;
  minimalTestGateway: boolean;
  logWarning: (message: string) => void;
  sidecars: GatewayPostReadySidecarHandle[];
}): Promise<void> {
  await params.chatMetadataLifecycle.attachContext(params.gatewayRequestContext, params.sidecars);
  if (!params.minimalTestGateway) {
    params.sidecars.push(startSecretStoreExpiryMaintenance(params.logWarning));
  }
  params.sidecars.push({
    stop: () => {
      params.flushPendingSessionsChangedEvents(params.gatewayRequestContext);
    },
  });
}
