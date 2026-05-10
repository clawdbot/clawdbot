import type { AccessGroupConfig } from "../../config/types.access-groups.js";
import type {
  AccessGroupMembershipFact,
  AccessGraphGate,
  ChannelIngressChannelId,
  ChannelIngressDecision,
  ChannelIngressEventInput,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ChannelIngressStateInput,
  IngressReasonCode,
  InternalChannelIngressAdapter,
  InternalChannelIngressSubject,
  InternalMatchMaterial,
  InternalNormalizedEntry,
  RouteGateFacts,
} from "./types.js";

/** Normalized identifier material used to match an inbound sender against allowlist entries. */
export type ChannelIngressSubjectIdentifier = InternalMatchMaterial;

/** Redacted subject identity assembled from a stable id plus optional platform aliases. */
export type ChannelIngressSubject = InternalChannelIngressSubject;

/** Normalized allowlist entry material produced by a channel identity adapter. */
export type ChannelIngressAdapterEntry = InternalNormalizedEntry;

/** Adapter used by the ingress resolver to normalize entries and match subjects. */
export type ChannelIngressAdapter = InternalChannelIngressAdapter;

/** Describes one identity field used for stable ids or platform-specific aliases. */
export type ChannelIngressIdentityField = {
  /** Unique field key used in subject alias maps and diagnostics. */
  key?: string;
  /** Redacted identifier kind written into the access graph. */
  kind?: ChannelIngressIdentifierKind;
  /** Shared normalizer used for both entries and subjects when no side-specific normalizer exists. */
  normalize?: (value: string) => string | null | undefined;
  /** Normalizes configured allowlist entries for this identity field. */
  normalizeEntry?: (value: string) => string | null | undefined;
  /** Normalizes inbound subject values for this identity field. */
  normalizeSubject?: (value: string) => string | null | undefined;
  /** Marks identifiers as dangerous in diagnostics, for example mutable display names. */
  dangerous?: boolean | ((value: string) => boolean | undefined);
  /** Redaction hint for diagnostics and access graph consumers. */
  sensitivity?: "normal" | "pii";
};

/** Named alias field such as email, phone, UUID, room id, or platform user id. */
export type ChannelIngressIdentityAlias = ChannelIngressIdentityField & {
  key: string;
};

/** Identity contract for a channel resolver. Plugins provide platform normalization here. */
export type ChannelIngressIdentityDescriptor = {
  /** Primary stable identity field. Prefer immutable sender ids when the platform has one. */
  primary: ChannelIngressIdentityField;
  /** Additional identifiers that can match legacy or platform-specific allowlist entries. */
  aliases?: readonly ChannelIngressIdentityAlias[];
  /** Returns true when a raw allowlist entry should authorize every sender. */
  isWildcardEntry?: (value: string) => boolean;
  /** Optional custom match hook for platform-specific identity equivalence. */
  matchEntry?: (params: {
    subject: ChannelIngressSubject;
    entry: ChannelIngressAdapterEntry;
    context: "dm" | "group" | "route" | "command";
  }) => boolean | undefined;
  /** Generates stable redacted entry ids for diagnostics. */
  resolveEntryId?: (params: {
    entry: string;
    entryIndex: number;
    fieldKey: string;
    fieldIndex: number;
  }) => string;
};

/** Convenience input for defining a stable identity descriptor with optional aliases. */
export type StableChannelIngressIdentityParams = ChannelIngressIdentityField &
  Pick<ChannelIngressIdentityDescriptor, "aliases" | "isWildcardEntry" | "matchEntry"> & {
    /** Prefix used for generated entry ids when `resolveEntryId` is omitted. */
    entryIdPrefix?: string;
    /** Custom entry-id generator used in redacted diagnostics. */
    resolveEntryId?: ChannelIngressIdentityDescriptor["resolveEntryId"];
  };

/** Raw sender identity passed by a plugin for one inbound event. */
export type ChannelIngressIdentitySubjectInput = {
  /** Stable sender id appended to effective allowlists when access groups matched. */
  stableId?: string | number | null;
  /** Optional identity aliases keyed by `ChannelIngressIdentityAlias.key`. */
  aliases?: Record<string, string | number | null | undefined>;
};

/** Minimal config subset consumed by the ingress resolver. */
export type ChannelIngressConfigInput = {
  /** Static or dynamic access group definitions referenced by allowlist entries. */
  accessGroups?: ChannelIngressStateInput["accessGroups"];
  /** Command config used for access-group command behavior. */
  commands?: { useAccessGroups?: boolean } | null;
} | null;

/** Command gate input for control-command authorization. */
export type ChannelMessageIngressCommandInput = NonNullable<
  ChannelIngressPolicyInput["command"]
> & {
  /** Explicit command-owner allowlist; defaults to effective DM allowlist. */
  commandOwnerAllowFrom?: Array<string | number> | null;
  /** Controls whether group command owners inherit configured DM owners. */
  groupOwnerAllowFrom?: "configured" | "none";
  /** Allows direct-message command checks to reuse effective group allowlists. */
  directGroupAllowFrom?: "effective" | "none";
  /** Group command allowFrom fallback, separate from normal group sender policy. */
  commandGroupAllowFromFallbackToAllowFrom?: boolean;
};

/** Preset form for command gates accepted by `createChannelIngressResolver`. */
export type ChannelIngressCommandPresetInput = Omit<
  Partial<ChannelMessageIngressCommandInput>,
  "useAccessGroups"
> & {
  /** Set false to omit the command gate entirely. */
  requested?: boolean;
  /** Overrides `cfg.commands.useAccessGroups` for this command decision. */
  useAccessGroups?: boolean | null;
  /** Config subset used to derive command access-group behavior. */
  cfg?: ChannelIngressConfigInput;
};

/** Preset form for event gates accepted by `createChannelIngressResolver`. */
export type ChannelIngressEventPresetInput = Partial<ChannelIngressEventInput> & {
  /** Convenience flag used to derive pairing defaults for group events. */
  isGroup?: boolean;
};

/** Optional route gate, such as a room, thread, topic, guild, or group route. */
export type ChannelIngressRouteDescriptor = {
  /** Stable route id used in diagnostics. */
  id: string;
  /** Route kind for diagnostics and graph consumers. */
  kind?: RouteGateFacts["kind"];
  /** Whether this route policy is configured. */
  configured?: boolean;
  /** Whether the inbound event matched this route. */
  matched?: boolean;
  /** Whether this route admits the inbound event. */
  allowed?: boolean;
  /** Whether to include this route descriptor in the graph. */
  enabled?: boolean;
  /** Ordering hint when multiple route descriptors are supplied. */
  precedence?: number;
  /** How route sender allowlists combine with effective channel allowlists. */
  senderPolicy?: RouteGateFacts["senderPolicy"];
  /** Route-specific sender allowlist entries. */
  senderAllowFrom?: Array<string | number> | null;
  /** Indicates whether route sender entries came from effective DM or group policy. */
  senderAllowFromSource?: RouteGateFacts["senderAllowFromSource"];
  /** Optional redacted match id for the route. */
  matchId?: string;
  /** Reason used when this route blocks the event. */
  blockReason?: string;
};

/** Dynamic access-group resolver invoked for groups that need platform lookups. */
export type ChannelIngressAccessGroupMembershipResolver = (params: {
  name: string;
  group: AccessGroupConfig;
  channelId: ChannelIngressChannelId;
  accountId: string;
  subject: ChannelIngressIdentitySubjectInput;
}) => boolean | Promise<boolean>;

/** Complete input for resolving one inbound channel message or event. */
export type ResolveChannelMessageIngressParams = {
  /** Channel id used for config, diagnostics, access groups, and pairing-store reads. */
  channelId: ChannelIngressChannelId;
  /** Account id scoped to this channel instance. */
  accountId: string;
  /** Identity descriptor that normalizes sender and allowlist material. */
  identity: ChannelIngressIdentityDescriptor;
  /** Inbound sender identity for this event. */
  subject: ChannelIngressIdentitySubjectInput;
  /** Conversation classification and id. */
  conversation: ChannelIngressStateInput["conversation"];
  /** Event auth mode and pairing/origin-subject facts. */
  event: ChannelIngressEventInput;
  /** Sender, command, event, route, and activation policy. */
  policy: ChannelIngressPolicyInput;
  /** Raw direct-message allowlist entries. */
  allowFrom?: Array<string | number> | null;
  /** Raw group sender allowlist entries. */
  groupAllowFrom?: Array<string | number> | null;
  /** Route descriptors used to build route gates. */
  route?: ChannelIngressRouteDescriptor | readonly ChannelIngressRouteDescriptor[];
  /** Prebuilt route facts for lower-level callers. */
  routeFacts?: RouteGateFacts[];
  /** Access group config referenced by allowlist entries. */
  accessGroups?: ChannelIngressStateInput["accessGroups"];
  /** Precomputed access-group memberships for this subject. */
  accessGroupMembership?: readonly AccessGroupMembershipFact[];
  /** Resolver for dynamic access groups. */
  resolveAccessGroupMembership?: ChannelIngressAccessGroupMembershipResolver;
  /** Concrete sender entry appended to effective allowlists when an access group matched. */
  accessGroupMatchedAllowFromEntry?: string | number | null;
  /** Records whether a provider-specific missing-config fallback was applied. */
  providerMissingFallbackApplied?: boolean;
  /** Mention or activation facts for activation gates. */
  mentionFacts?: ChannelIngressStateInput["mentionFacts"];
  /** Optional pairing-store reader for direct-message allowlist material. */
  readStoreAllowFrom?: (params: {
    channelId: ChannelIngressChannelId;
    accountId: string;
    dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
  }) => Promise<readonly (string | number)[] | null | undefined>;
  /** Reads the default pairing store when no explicit reader is supplied. */
  useDefaultPairingStore?: boolean;
  /** Command gate input; omit when no command policy is requested. */
  command?: ChannelMessageIngressCommandInput;
};

/** Shared resolver defaults for repeated events from the same channel account. */
export type CreateChannelIngressResolverParams = Pick<
  ResolveChannelMessageIngressParams,
  | "channelId"
  | "accountId"
  | "identity"
  | "accessGroups"
  | "accessGroupMembership"
  | "resolveAccessGroupMembership"
  | "accessGroupMatchedAllowFromEntry"
  | "readStoreAllowFrom"
  | "useDefaultPairingStore"
> & {
  /** Config subset used for access groups and command behavior. */
  cfg?: ChannelIngressConfigInput;
  /** Global override for access-group expansion in this resolver. */
  useAccessGroups?: boolean | null;
  /** Default DM policy for message calls that omit it. */
  defaultDmPolicy?: ChannelIngressPolicyInput["dmPolicy"];
  /** Default group policy for message calls that omit it. */
  defaultGroupPolicy?: ChannelIngressPolicyInput["groupPolicy"];
  /** Default group allowlist fallback behavior. */
  groupAllowFromFallbackToAllowFrom?: boolean;
  /** Mutable identifier matching policy for this resolver. */
  mutableIdentifierMatching?: ChannelIngressPolicyInput["mutableIdentifierMatching"];
};

/** Per-message input for a resolver created by `createChannelIngressResolver`. */
export type ChannelIngressResolverMessageParams = Omit<
  ResolveChannelMessageIngressParams,
  | "channelId"
  | "accountId"
  | "identity"
  | "accessGroups"
  | "resolveAccessGroupMembership"
  | "accessGroupMatchedAllowFromEntry"
  | "readStoreAllowFrom"
  | "useDefaultPairingStore"
  | "event"
  | "policy"
  | "command"
> & {
  /** Event facts or presets; defaults to a normal inbound message event. */
  event?: ChannelIngressEventInput | ChannelIngressEventPresetInput;
  /** DM policy override for this event. */
  dmPolicy?: ChannelIngressPolicyInput["dmPolicy"];
  /** Group policy override for this event. */
  groupPolicy?: ChannelIngressPolicyInput["groupPolicy"];
  /** Additional policy fields merged with resolver defaults. */
  policy?: Partial<Omit<ChannelIngressPolicyInput, "dmPolicy" | "groupPolicy">>;
  /** Command gate input, preset, or false to suppress command checks. */
  command?: ChannelMessageIngressCommandInput | ChannelIngressCommandPresetInput | false;
};

/** Reusable high-level ingress resolver for message, command, and event surfaces. */
export type ChannelIngressResolver = {
  /** Resolve a normal inbound message with sender, route, command, event, and activation gates. */
  message(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>;
  /** Resolve a command-oriented event with command auth defaults enabled. */
  command(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>;
  /** Resolve a non-message event with event-gate defaults enabled. */
  event(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>;
};

/** One-shot helper input using a simple stable identity descriptor. */
export type ResolveStableChannelMessageIngressParams = Omit<
  CreateChannelIngressResolverParams,
  "identity"
> &
  ChannelIngressResolverMessageParams & { identity?: StableChannelIngressIdentityParams };

/** Sender/conversation projection consumed by channel handlers. */
export type ChannelIngressSenderAccess = {
  /** True when the sender gate admits the event. */
  allowed: boolean;
  /** Final ingress decision after all gates, not just the sender gate. */
  decision: ChannelIngressDecision["decision"];
  /** Sender gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode;
  /** Sender gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
  /** Effective DM allowlist entries after store and access-group processing. */
  effectiveAllowFrom: string[];
  /** Effective group allowlist entries after fallback and access-group processing. */
  effectiveGroupAllowFrom: string[];
  /** Whether provider-specific fallback behavior was applied. */
  providerMissingFallbackApplied: boolean;
};

/** Command projection consumed by channel command/control handlers. */
export type ChannelIngressCommandAccess = {
  /** True when a command gate was requested for this event. */
  requested: boolean;
  /** True when the command gate authorizes this sender. */
  authorized: boolean;
  /** True when an unauthorized control command should be blocked. */
  shouldBlockControlCommand: boolean;
  /** Command gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode;
  /** Command gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};

/** Route projection consumed by room/thread/topic handlers. */
export type ChannelIngressRouteAccess = {
  /** True when all configured route gates admit the event. */
  allowed: boolean;
  /** Route gate reason when a route gate decided. */
  reasonCode?: IngressReasonCode;
  /** Optional route-specific reason text. */
  reason?: string;
  /** Route gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};

/** Activation/mention projection consumed by group handlers. */
export type ChannelIngressActivationAccess = {
  /** True when an activation gate ran. */
  ran: boolean;
  /** True when activation admits the event. */
  allowed: boolean;
  /** True when the event should be skipped instead of dispatched. */
  shouldSkip: boolean;
  /** Activation gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode;
  /** Effective mention match after command bypass and activation policy. */
  effectiveWasMentioned?: boolean;
  /** True when mention gating was bypassed by policy or command facts. */
  shouldBypassMention?: boolean;
  /** Activation gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};

/** Full ingress result returned by runtime resolvers. */
export type ResolvedChannelMessageIngress = {
  /** Redacted normalized state used as input to the decision engine. */
  state: ChannelIngressState;
  /** Ordered access graph plus final admission decision. */
  ingress: ChannelIngressDecision;
  /** Sender/conversation projection. */
  senderAccess: ChannelIngressSenderAccess;
  /** Route projection. */
  routeAccess: ChannelIngressRouteAccess;
  /** Command projection. */
  commandAccess: ChannelIngressCommandAccess;
  /** Activation/mention projection. */
  activationAccess: ChannelIngressActivationAccess;
};
