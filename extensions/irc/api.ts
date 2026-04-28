export { ircPlugin } from "./src/channel.js";
export { setIrcRuntime } from "./src/runtime.js";
export {
  listEnabledIrcAccounts,
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  type ResolvedIrcAccount,
  resolveIrcAccount,
} from "./src/accounts.js";
export { ircSetupAdapter, ircSetupWizard } from "./src/setup-surface.js";
