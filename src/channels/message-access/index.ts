// Public channel ingress/message-access barrel. Keep this as the narrow import
// point for callers that need access decisions without plugin internals.
export { defineStableChannelIngressIdentity } from "./runtime-identity.js";
export {
  channelIngressRoutes,
  createChannelIngressResolver,
  resolveChannelMessageIngress,
  resolveStableChannelMessageIngress,
} from "./runtime.js";
export { readChannelIngressStoreAllowFromForDmPolicy } from "./store-allow-from.js";

export type {
  ChannelIngressAccessGroupMembershipResolver,
  ChannelIngressCommandPresetInput,
  ChannelIngressConfigInput,
  ChannelIngressEventPresetInput,
  ChannelIngressIdentityAlias,
  ChannelIngressIdentityDescriptor,
  ChannelIngressIdentityField,
  ChannelIngressIdentitySubjectInput,
  ChannelIngressRouteAccess,
  ChannelIngressRouteDescriptor,
  ChannelIngressResolver,
  ChannelIngressResolverMessageParams,
  ChannelMessageIngressCommandInput,
  CreateChannelIngressResolverParams,
  ResolvedChannelMessageIngress,
  ResolveChannelMessageIngressParams,
  ResolveStableChannelMessageIngressParams,
  StableChannelIngressIdentityParams,
} from "./runtime-types.js";
export type * from "./types.js";
