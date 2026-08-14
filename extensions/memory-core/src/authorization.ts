import type { MemoryAuthorizationCapabilities } from "openclaw/plugin-sdk/memory-authorization";

/** Keep the lazy plugin entrypoint from loading the conformance suite just to declare legacy mode. */
export const MEMORY_CORE_AUTHORIZATION_CAPABILITIES = Object.freeze({
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
