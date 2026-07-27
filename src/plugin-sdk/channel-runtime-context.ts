/**
 * Runtime SDK subpath for registering and watching channel runtime contexts.
 */
export {
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
  watchChannelRuntimeContexts,
} from "../infra/channel-runtime-context.js";
export type { ChannelRuntimeContextKey } from "../channels/plugins/channel-runtime-surface.types.js";
