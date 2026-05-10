/**
 * High-level runtime resolver for inbound channel access decisions.
 *
 * Channel plugins should use this subpath for new receive paths. It accepts
 * platform facts, raw allowlists, route descriptors, command facts, and access
 * group config, then returns sender/route/command/activation projections plus
 * the ordered ingress graph.
 */
export {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  readChannelIngressStoreAllowFromForDmPolicy,
  resolveChannelMessageIngress,
  resolveStableChannelMessageIngress,
} from "../channels/message-access/index.js";
export type {
  AccessGroupMembershipFact,
  ChannelIngressDecision,
  ChannelIngressAccessGroupMembershipResolver,
  ChannelIngressCommandPresetInput,
  ChannelIngressConfigInput,
  ChannelIngressEventInput,
  ChannelIngressEventPresetInput,
  ChannelIngressIdentityDescriptor,
  ChannelIngressIdentityAlias,
  ChannelIngressIdentityField,
  ChannelIngressIdentitySubjectInput,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressRouteAccess,
  ChannelIngressRouteDescriptor,
  ChannelIngressResolver,
  ChannelIngressResolverMessageParams,
  ChannelIngressStateInput,
  ChannelIngressState,
  ChannelMessageIngressCommandInput,
  CreateChannelIngressResolverParams,
  IngressReasonCode,
  ResolvedChannelMessageIngress,
  ResolveChannelMessageIngressParams,
  ResolveStableChannelMessageIngressParams,
  StableChannelIngressIdentityParams,
} from "../channels/message-access/index.js";
