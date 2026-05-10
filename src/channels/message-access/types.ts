import type { AccessGroupConfig } from "../../config/types.access-groups.js";
import type { ChatChannelId } from "../ids.js";
import type { InboundImplicitMentionKind, InboundMentionFacts } from "../mention-gating.js";

/** Channel identifier used in ingress diagnostics and config lookups. */
export type ChannelIngressChannelId = ChatChannelId;

/** Redacted identifier category used by allowlist normalization and matching. */
export type ChannelIngressIdentifierKind =
  | "stable-id"
  | "username"
  | "email"
  | "phone"
  | "role"
  | `plugin:${string}`;

/** Public, redacted identifier material that can participate in allowlist matching. */
export type MatchableIdentifier = {
  opaqueId: string;
  kind: ChannelIngressIdentifierKind;
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};

/** Internal identifier material with the raw comparable value retained. */
export type InternalMatchMaterial = MatchableIdentifier & {
  value: string;
};

/** Internal subject representation used by the shared ingress kernel. */
export type InternalChannelIngressSubject = {
  identifiers: InternalMatchMaterial[];
};

/** Public, redacted form of a normalized allowlist entry. */
export type ChannelIngressNormalizedEntry = {
  opaqueEntryId: string;
  kind: ChannelIngressIdentifierKind;
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};

/** Internal normalized allowlist entry with its raw comparable value retained. */
export type InternalNormalizedEntry = ChannelIngressNormalizedEntry & {
  value: string;
};

/** Redacted diagnostic for an invalid, disabled, or unsupported allowlist entry. */
export type RedactedIngressEntryDiagnostic = {
  opaqueEntryId?: string;
  reasonCode: IngressReasonCode;
};

/** Redacted allowlist match result exposed to callers and access facts. */
export type RedactedIngressMatch = {
  matched: boolean;
  matchedEntryIds: string[];
};

/** Public normalization result for a set of allowlist entries. */
export type ChannelIngressNormalizeResult = {
  matchable: ChannelIngressNormalizedEntry[];
  invalid: RedactedIngressEntryDiagnostic[];
  disabled: RedactedIngressEntryDiagnostic[];
};

/** Internal normalization result with raw comparable entry values retained. */
export type InternalChannelIngressNormalizeResult = Omit<
  ChannelIngressNormalizeResult,
  "matchable"
> & {
  matchable: InternalNormalizedEntry[];
};

/** Adapter that gives the shared ingress kernel channel-specific identity matching. */
export type InternalChannelIngressAdapter = {
  normalizeEntries(params: {
    entries: readonly string[];
    context: "dm" | "group" | "route" | "command";
    accountId: string;
  }): InternalChannelIngressNormalizeResult | Promise<InternalChannelIngressNormalizeResult>;

  matchSubject(params: {
    subject: InternalChannelIngressSubject;
    entries: readonly InternalNormalizedEntry[];
    context: "dm" | "group" | "route" | "command";
  }): RedactedIngressMatch | Promise<RedactedIngressMatch>;
};

/** Resolved access-group membership fact used by allowlist entries. */
export type AccessGroupMembershipFact =
  | {
      kind: "matched";
      groupName: string;
      source: "static" | "dynamic";
      matchedEntryIds: string[];
    }
  | {
      kind: "not-matched";
      groupName: string;
      source: "static" | "dynamic";
    }
  | {
      kind: "missing" | "unsupported" | "failed";
      groupName: string;
      source: "static" | "dynamic";
      reasonCode: IngressReasonCode;
      diagnosticId?: string;
    };

/** Fully normalized allowlist facts for one ingress gate. */
export type ResolvedIngressAllowlist = {
  rawEntryCount: number;
  normalizedEntries: ChannelIngressNormalizedEntry[];
  invalidEntries: RedactedIngressEntryDiagnostic[];
  disabledEntries: RedactedIngressEntryDiagnostic[];
  matchedEntryIds: string[];
  hasConfiguredEntries: boolean;
  hasMatchableEntries: boolean;
  hasWildcard: boolean;
  accessGroups: {
    referenced: string[];
    matched: string[];
    missing: string[];
    unsupported: string[];
    failed: string[];
  };
  match: RedactedIngressMatch;
};

/** Redacted allowlist facts safe to expose in the access graph. */
export type RedactedIngressAllowlistFacts = {
  configured: boolean;
  matched: boolean;
  reasonCode: IngressReasonCode;
  matchedEntryIds: string[];
  invalidEntryCount: number;
  disabledEntryCount: number;
  accessGroups: ResolvedIngressAllowlist["accessGroups"];
};

/** Route lookup state projected into the ingress access graph. */
export type RouteGateState =
  | "not-configured"
  | "matched"
  | "not-matched"
  | "disabled"
  | "lookup-failed";

/** How a matched route affects sender allowlist evaluation. */
export type RouteSenderPolicy = "inherit" | "replace" | "deny-when-empty";

/** Source list used when a route sender policy contributes sender entries. */
export type RouteSenderAllowlistSource = "effective-dm" | "effective-group";

/** Raw route gate facts supplied by a channel-specific router. */
export type RouteGateFacts = {
  id: string;
  kind: "route" | "routeSender" | "membership" | "ownerAllowlist" | "nestedAllowlist";
  gate: RouteGateState;
  effect: "allow" | "block-dispatch" | "ignore";
  precedence: number;
  senderPolicy: RouteSenderPolicy;
  senderAllowFrom?: Array<string | number>;
  senderAllowFromSource?: RouteSenderAllowlistSource;
  match?: RedactedIngressMatch;
};

/** Route gate facts after any route-specific sender allowlist is normalized. */
export type ResolvedRouteGateFacts = Omit<
  RouteGateFacts,
  "senderAllowFrom" | "senderAllowFromSource"
> & {
  senderAllowlist?: ResolvedIngressAllowlist;
};

/** Inbound event facts used to choose command, pairing, and origin-subject rules. */
export type ChannelIngressEventInput = {
  kind:
    | "message"
    | "reaction"
    | "button"
    | "postback"
    | "native-command"
    | "slash-command"
    | "system";
  authMode: "inbound" | "command" | "origin-subject" | "route-only" | "none";
  mayPair: boolean;
  originSubject?: InternalChannelIngressSubject;
};

/** Redacted event facts exposed in decisions and access facts. */
export type RedactedChannelIngressEvent = Omit<ChannelIngressEventInput, "originSubject"> & {
  hasOriginSubject: boolean;
  originSubjectMatched: boolean;
};

/** Complete raw input to the shared ingress state resolver. */
export type ChannelIngressStateInput = {
  channelId: ChannelIngressChannelId;
  accountId: string;
  subject: InternalChannelIngressSubject;
  conversation: {
    kind: "direct" | "group" | "channel";
    id: string;
    parentId?: string;
    threadId?: string;
    title?: string;
  };
  adapter: InternalChannelIngressAdapter;
  accessGroups?: Record<string, AccessGroupConfig>;
  accessGroupMembership?: readonly AccessGroupMembershipFact[];
  routeFacts?: RouteGateFacts[];
  mentionFacts?: InboundMentionFacts;
  event: ChannelIngressEventInput;
  allowlists: {
    dm?: Array<string | number>;
    group?: Array<string | number>;
    commandOwner?: Array<string | number>;
    commandGroup?: Array<string | number>;
    pairingStore?: Array<string | number>;
  };
};

/** Policy knobs that decide how the ingress graph is evaluated. */
export type ChannelIngressPolicyInput = {
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy: "allowlist" | "open" | "disabled";
  groupAllowFromFallbackToAllowFrom?: boolean;
  mutableIdentifierMatching?: "disabled" | "enabled";
  activation?: {
    requireMention: boolean;
    allowTextCommands: boolean;
    allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
    order?: "before-sender" | "after-command";
  };
  command?: {
    useAccessGroups?: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  };
};

/** Ordered phase for a gate in the ingress graph. */
export type IngressGatePhase = "route" | "sender" | "command" | "event" | "activation";

/** Gate kind used in the ingress graph and projected access facts. */
export type IngressGateKind =
  | "route"
  | "routeSender"
  | "dmSender"
  | "groupSender"
  | "membership"
  | "ownerAllowlist"
  | "nestedAllowlist"
  | "command"
  | "event"
  | "mention";

/** Effect produced by a gate when computing final ingress admission. */
export type IngressGateEffect =
  | "allow"
  | "block-dispatch"
  | "block-command"
  | "skip"
  | "observe"
  | "ignore";

/** Stable machine-readable reason code for ingress diagnostics. */
export type IngressReasonCode =
  | "allowed"
  | "route_blocked"
  | "route_sender_empty"
  | "dm_policy_disabled"
  | "dm_policy_open"
  | "dm_policy_allowlisted"
  | "dm_policy_pairing_required"
  | "dm_policy_not_allowlisted"
  | "group_policy_disabled"
  | "group_policy_open"
  | "group_policy_allowed"
  | "group_policy_empty_allowlist"
  | "group_policy_not_allowlisted"
  | "command_authorized"
  | "control_command_unauthorized"
  | "event_authorized"
  | "event_unauthorized"
  | "event_pairing_not_allowed"
  | "sender_not_required"
  | "origin_subject_missing"
  | "origin_subject_not_matched"
  | "activation_allowed"
  | "activation_skipped"
  | "access_group_missing"
  | "access_group_unsupported"
  | "access_group_failed"
  | "mutable_identifier_disabled"
  | "no_policy_match";

/** One evaluated gate in the ordered ingress access graph. */
export type AccessGraphGate = {
  id: string;
  phase: IngressGatePhase;
  kind: IngressGateKind;
  effect: IngressGateEffect;
  allowed: boolean;
  reasonCode: IngressReasonCode;
  match?: RedactedIngressMatch;
  allowlist?: RedactedIngressAllowlistFacts;
  sender?: {
    policy: ChannelIngressPolicyInput["dmPolicy"] | ChannelIngressPolicyInput["groupPolicy"];
  };
  command?: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
    shouldBlockControlCommand: boolean;
  };
  event?: RedactedChannelIngressEvent;
  activation?: {
    hasMentionFacts: boolean;
    requireMention: boolean;
    allowTextCommands: boolean;
    allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
    order?: "before-sender" | "after-command";
    shouldSkip: boolean;
    canDetectMention?: boolean;
    wasMentioned?: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: readonly InboundImplicitMentionKind[];
    effectiveWasMentioned?: boolean;
    shouldBypassMention?: boolean;
  };
};

/** Ordered graph of all evaluated ingress gates. */
export type AccessGraph = {
  gates: AccessGraphGate[];
};

/** Normalized ingress state before policy gates are reduced into a decision. */
export type ChannelIngressState = {
  channelId: ChannelIngressChannelId;
  accountId: string;
  conversationKind: "direct" | "group" | "channel";
  event: RedactedChannelIngressEvent;
  mentionFacts?: InboundMentionFacts;
  routeFacts: ResolvedRouteGateFacts[];
  allowlists: {
    dm: ResolvedIngressAllowlist;
    pairingStore: ResolvedIngressAllowlist;
    group: ResolvedIngressAllowlist;
    commandOwner: ResolvedIngressAllowlist;
    commandGroup: ResolvedIngressAllowlist;
  };
};

/** Final runtime admission action for the inbound event. */
export type ChannelIngressAdmission = "dispatch" | "observe" | "skip" | "drop" | "pairing-required";

/** Final decision and graph for a resolved channel ingress event. */
export type ChannelIngressDecision = {
  admission: ChannelIngressAdmission;
  decision: "allow" | "block" | "pairing";
  decisiveGateId: string;
  reasonCode: IngressReasonCode;
  graph: AccessGraph;
};
