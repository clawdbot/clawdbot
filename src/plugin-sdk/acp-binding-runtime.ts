// Deprecated compatibility for released @openclaw/matrix packages.
// Remove next major after supported Matrix versions no longer import this lazy lifecycle surface.

export { ensureConfiguredAcpBindingReadyCore as ensureConfiguredAcpBindingReady } from "../acp/persistent-bindings.lifecycle.js";
export { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
