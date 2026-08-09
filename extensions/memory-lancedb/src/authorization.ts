import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";

/** Keep plugin registration lazy: the public conformance suite is not a runtime dependency here. */
export const LANCEDB_MEMORY_AUTHORIZATION_CAPABILITIES = Object.freeze({
  version: 1,
  scopedCandidates: false,
  exactReadByAuthorizedHandle: false,
  scopedSync: false,
  scopedWrite: false,
  scopedImport: false,
  scopedExport: false,
  scopedStatus: false,
  exposureReceipts: false,
  egressReceipts: false,
}) satisfies NonNullable<MemoryPluginCapability["authorization"]>;
