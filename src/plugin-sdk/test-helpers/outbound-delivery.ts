export {
  addTestHook,
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  initializeGlobalHookRunner,
  releasePinnedPluginChannelRegistry,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
} from "../testing.js";
/** @deprecated Direct outbound delivery is runtime substrate; use channel message runtime helpers. */
export { deliverOutboundPayloads } from "../testing.js";
