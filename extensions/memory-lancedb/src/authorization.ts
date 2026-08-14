import type { MemoryAuthorizationCapabilities } from "openclaw/plugin-sdk/memory-authorization";

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
}) satisfies MemoryAuthorizationCapabilities;
