/**
 * Public SDK subpath for command authorization and control-command gating.
 */
export type {
  CommandAuthorizer,
  CommandGatingModeWhenAccessGroupsOff,
} from "../channels/command-gating.js";
export {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
  resolveDualTextControlCommandGate,
} from "../channels/command-gating.js";
