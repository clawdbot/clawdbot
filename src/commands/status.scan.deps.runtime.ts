import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";

export { getTailnetHostname };

type StatusMemoryManager = {
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  status(): MemoryProviderStatus;
  close?(): Promise<void>;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: "status";
}): Promise<{ manager: StatusMemoryManager | null }> {
  const { manager } = await getActiveMemorySearchManager(params);
  if (!manager) {
    return { manager: null };
  }
  const probeVectorStoreAvailability = manager.probeVectorStoreAvailability
    ? async () => await manager.probeVectorStoreAvailability!()
    : undefined;
  return {
    manager: {
      probeVectorStoreAvailability,
      async probeVectorAvailability() {
        return await manager.probeVectorAvailability();
      },
      status() {
        return manager.status();
      },
      close: manager.close ? async () => await manager.close?.() : undefined,
    },
  };
}
