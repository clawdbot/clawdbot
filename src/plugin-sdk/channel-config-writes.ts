/**
 * Public SDK subpath for channel config write authorization and scope helpers.
 */
export {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
  resolveChannelConfigWrites,
} from "./channel-config-helpers.js";
export type {
  ConfigWriteAuthorizationResult,
  ConfigWriteScope,
  ConfigWriteTarget,
} from "./channel-config-helpers.js";
