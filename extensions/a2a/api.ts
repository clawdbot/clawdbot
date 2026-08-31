export {
  DEFAULT_ACCOUNT_ID,
  listA2aChannelAccountIds,
  resolveA2aChannelAccount,
  resolveDefaultA2aChannelAccountId,
} from "./src/accounts.js";
export { a2aChannelPlugin } from "./src/channel.js";
export { getA2aChannelRuntime, setA2aChannelRuntime } from "./src/runtime.js";
export type {
  A2aChannelConfig,
  A2aCoreConfig,
  A2aPeerConfig,
  ResolvedA2aChannelAccount,
} from "./src/types.js";
