import type { MemoryAuthorizationCapabilities } from "openclaw/plugin-sdk/memory-authorization";

/** Phase 1C admits only scoped candidate search and exact opaque-handle reads. */
export const MEMORY_CORE_AUTHORIZATION_CAPABILITIES = Object.freeze({
  version: 1,
  scopedCandidates: true,
  exactReadByAuthorizedHandle: true,
  scopedSync: false,
  scopedWrite: false,
  scopedImport: false,
  scopedExport: false,
  scopedStatus: false,
  exposureReceipts: false,
  egressReceipts: false,
}) satisfies MemoryAuthorizationCapabilities;
