// Runtime facade keeping inbound session persistence lazy behind the session accessor.
export { resolveSessionStorePathCore } from "./paths.js";
export { recordInboundSessionMeta, updateSessionLastRoute } from "./session-accessor.js";
