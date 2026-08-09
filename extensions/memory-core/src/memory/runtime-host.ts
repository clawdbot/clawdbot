import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MemoryCoreOpenKeyedStore } from "../dreaming-state.js";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";

export type MemoryCoreRuntimeHost = {
  acquireLocalService?: MemoryCoreAcquireLocalService;
  openKeyedStore?: MemoryCoreOpenKeyedStore;
  withLease?: PluginStateLeaseRunner;
};
