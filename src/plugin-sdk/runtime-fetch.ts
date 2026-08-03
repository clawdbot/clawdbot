// Narrow runtime fetch helpers for plugins that need dispatcher-aware fetch
// without importing the broad infra-runtime compatibility barrel.

export {
  fetchWithRuntimeDispatcher,
  fetchWithRuntimeDispatcherOrMockedGlobal,
  isMockedFetch,
  type DispatcherAwareRequestInit,
} from "../infra/net/runtime-fetch.js";
