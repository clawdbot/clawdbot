/**
 * Public runtime injection surface used by the bundled ClickClack entry.
 */
export {
  type ClickClackAccountConfig,
  type ClickClackEvent,
  type ClickClackMessage,
  type ClickClackTarget,
  type ResolvedClickClackAccount,
  createClickClackClient,
  parseClickClackTarget,
  resolveClickClackAccount,
  setClickClackRuntime,
} from "./api.js";
