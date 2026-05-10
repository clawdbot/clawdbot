import {
  decideChannelIngress,
  resolveChannelIngressState as resolveChannelIngressStateInternal,
} from "../channels/message-access/index.js";
import type {
  AccessGraphGate,
  ChannelIngressDecision,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ChannelIngressStateInput as MessageAccessChannelIngressStateInput,
  IngressGateKind,
  IngressGatePhase,
  InternalChannelIngressAdapter,
  InternalChannelIngressNormalizeResult,
  InternalChannelIngressSubject,
  InternalMatchMaterial,
  InternalNormalizedEntry,
  IngressReasonCode,
} from "../channels/message-access/index.js";
import type { AccessFacts, ChannelTurnAdmission } from "../channels/turn/types.js";
import type {
  DmGroupAccessDecision,
  DmGroupAccessReasonCode,
} from "../security/dm-policy-shared.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

export { decideChannelIngress };
export type {
  AccessGraph,
  AccessGraphGate,
  AccessGroupMembershipFact,
  ChannelIngressAdmission,
  ChannelIngressChannelId,
  ChannelIngressDecision,
  ChannelIngressEventInput,
  ChannelIngressIdentifierKind,
  ChannelIngressNormalizedEntry,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  IngressGateEffect,
  IngressGateKind,
  IngressGatePhase,
  IngressReasonCode,
  MatchableIdentifier,
  RedactedChannelIngressEvent,
  RedactedIngressAllowlistFacts,
  RedactedIngressEntryDiagnostic,
  RedactedIngressMatch,
  ResolvedIngressAllowlist,
  ResolvedRouteGateFacts,
  RouteGateFacts,
  RouteGateState,
  RouteSenderAllowlistSource,
  RouteSenderPolicy,
} from "../channels/message-access/index.js";

export type ChannelIngressSubjectIdentifier = InternalMatchMaterial;
export type ChannelIngressSubject = InternalChannelIngressSubject;
export type ChannelIngressAdapterEntry = InternalNormalizedEntry;
export type ChannelIngressAdapterNormalizeResult = InternalChannelIngressNormalizeResult;
export type ChannelIngressAdapter = InternalChannelIngressAdapter;
export type ChannelIngressStateInput = MessageAccessChannelIngressStateInput;

declare const CHANNEL_INGRESS_PLUGIN_ID: unique symbol;

export type ChannelIngressPluginId = string & {
  readonly [CHANNEL_INGRESS_PLUGIN_ID]: true;
};

export type ChannelIngressGateSelector = {
  phase: IngressGatePhase;
  kind: IngressGateKind;
};

export type ChannelIngressDecisionBundle = {
  dm: ChannelIngressDecision;
  group: ChannelIngressDecision;
  dmCommand: ChannelIngressDecision;
  groupCommand: ChannelIngressDecision;
};

export type ChannelIngressSideEffectResult =
  | { kind: "none" }
  | { kind: "pairing-reply-sent" }
  | { kind: "pairing-reply-failed"; errorCode?: string }
  | { kind: "command-reply-sent" }
  | { kind: "command-reply-failed"; errorCode?: string }
  | { kind: "pending-history-recorded" }
  | { kind: "local-event-handled" };

export type RedactedIngressDiagnostics = {
  decisiveGateId?: string;
  reasonCode: IngressReasonCode;
};

export const CHANNEL_INGRESS_GATE_SELECTORS = {
  command: { phase: "command", kind: "command" },
  activation: { phase: "activation", kind: "mention" },
  dmSender: { phase: "sender", kind: "dmSender" },
  groupSender: { phase: "sender", kind: "groupSender" },
  event: { phase: "event", kind: "event" },
} as const satisfies Record<string, ChannelIngressGateSelector>;

export type ChannelIngressSubjectIdentifierInput = {
  value: string;
  opaqueId?: string;
  kind?: ChannelIngressIdentifierKind;
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};

export type CreateChannelIngressStringAdapterParams = {
  kind?: ChannelIngressIdentifierKind;
  normalizeEntry?: (value: string) => string | null | undefined;
  normalizeSubject?: (value: string) => string | null | undefined;
  isWildcardEntry?: (value: string) => boolean;
  resolveEntryId?: (params: { entry: string; index: number }) => string;
  dangerous?: boolean | ((entry: string) => boolean);
  sensitivity?: "normal" | "pii";
};

export type CreateChannelIngressMultiIdentifierAdapterParams = {
  normalizeEntry: (entry: string, index: number) => readonly ChannelIngressAdapterEntry[];
  getEntryMatchKey?: (entry: ChannelIngressAdapterEntry) => string | null | undefined;
  getSubjectMatchKeys?: (
    identifier: ChannelIngressSubjectIdentifier,
  ) => readonly (string | null | undefined)[];
  isWildcardEntry?: (entry: ChannelIngressAdapterEntry) => boolean;
};

export type ChannelIngressDmGroupAccessProjection = {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};

export type ChannelIngressSenderGroupAccessProjection = {
  allowed: boolean;
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  providerMissingFallbackApplied: boolean;
  reason: "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolveChannelIngressAccessParams = ChannelIngressStateInput & {
  policy: ChannelIngressPolicyInput;
  effectiveAllowFrom?: readonly string[];
  effectiveGroupAllowFrom?: readonly string[];
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolvedChannelIngressAccess = {
  state: ChannelIngressState;
  ingress: ChannelIngressDecision;
  isGroup: boolean;
  senderReasonCode: IngressReasonCode;
  access: ChannelIngressDmGroupAccessProjection & {
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
  };
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
};

function defaultNormalize(value: string): string {
  return value;
}

function normalizeMatchValue(
  value: string,
  normalize: (value: string) => string | null | undefined,
): string | null {
  const normalized = normalize(value);
  return normalized == null ? null : normalized.trim() || null;
}

function resolveDangerous(
  dangerous: CreateChannelIngressStringAdapterParams["dangerous"],
  entry: string,
): boolean | undefined {
  return typeof dangerous === "function" ? dangerous(entry) : dangerous;
}

function defaultIngressMatchKey(params: {
  kind: ChannelIngressIdentifierKind;
  value: string;
}): string {
  return `${params.kind}:${params.value}`;
}

export function findChannelIngressGate(
  decision: ChannelIngressDecision,
  selector: ChannelIngressGateSelector,
): AccessGraphGate | undefined {
  return decision.graph.gates.find(
    (gate) => gate.phase === selector.phase && gate.kind === selector.kind,
  );
}

export function findChannelIngressSenderGate(
  decision: ChannelIngressDecision,
  params: { isGroup: boolean },
): AccessGraphGate | undefined {
  return findChannelIngressGate(
    decision,
    params.isGroup
      ? CHANNEL_INGRESS_GATE_SELECTORS.groupSender
      : CHANNEL_INGRESS_GATE_SELECTORS.dmSender,
  );
}

export function findChannelIngressCommandGate(
  decision: ChannelIngressDecision,
): AccessGraphGate | undefined {
  return findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.command);
}

export function decideChannelIngressBundle(params: {
  directState: ChannelIngressState;
  groupState: ChannelIngressState;
  basePolicy: ChannelIngressPolicyInput;
  commandPolicy: ChannelIngressPolicyInput;
}): ChannelIngressDecisionBundle {
  return {
    dm: decideChannelIngress(params.directState, params.basePolicy),
    group: decideChannelIngress(params.groupState, params.basePolicy),
    dmCommand: decideChannelIngress(params.directState, params.commandPolicy),
    groupCommand: decideChannelIngress(params.groupState, params.commandPolicy),
  };
}

function projectGroupPolicy(
  gate: AccessGraphGate | undefined,
): NonNullable<AccessFacts["group"]>["policy"] {
  const policy = gate?.sender?.policy;
  return policy === "open" || policy === "disabled" ? policy : "allowlist";
}

function projectMentionFacts(gate: AccessGraphGate | undefined): AccessFacts["mentions"] {
  const activation = gate?.activation;
  if (!activation?.hasMentionFacts) {
    return undefined;
  }
  return {
    canDetectMention: activation.canDetectMention ?? false,
    wasMentioned: activation.wasMentioned ?? false,
    hasAnyMention: activation.hasAnyMention,
    implicitMentionKinds: activation.implicitMentionKinds
      ? [...activation.implicitMentionKinds]
      : undefined,
    requireMention: activation.requireMention,
    effectiveWasMentioned: activation.effectiveWasMentioned,
    shouldSkip: activation.shouldSkip,
  };
}

function projectDmDecision(
  decision: ChannelIngressDecision,
  dmSender: AccessGraphGate | undefined,
): NonNullable<AccessFacts["dm"]>["decision"] {
  if (decision.decision === "pairing") {
    return "pairing";
  }
  if (dmSender) {
    return dmSender.allowed ? "allow" : "deny";
  }
  return decision.admission === "drop" ? "deny" : "allow";
}

export function projectIngressAccessFacts(decision: ChannelIngressDecision): AccessFacts {
  const command = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.command);
  const activation = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.activation);
  const dmSender = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.dmSender);
  const groupSender = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.groupSender);
  const event = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.event);
  return {
    dm: {
      decision: projectDmDecision(decision, dmSender),
      reason: dmSender?.reasonCode ?? decision.reasonCode,
      allowFrom: [],
      allowlist: dmSender?.allowlist,
    },
    group: {
      policy: projectGroupPolicy(groupSender),
      routeAllowed: !decision.graph.gates.some(
        (gate) => gate.phase === "route" && gate.effect === "block-dispatch",
      ),
      senderAllowed: groupSender?.allowed ?? dmSender?.allowed ?? false,
      allowFrom: [],
      requireMention: activation?.activation?.requireMention ?? false,
      allowlist: groupSender?.allowlist,
    },
    commands: command?.command
      ? {
          authorized: command.allowed,
          shouldBlockControlCommand: command.command.shouldBlockControlCommand,
          reasonCode: command.reasonCode,
          useAccessGroups: command.command.useAccessGroups,
          allowTextCommands: command.command.allowTextCommands,
          modeWhenAccessGroupsOff: command.command.modeWhenAccessGroupsOff,
          authorizers: [],
        }
      : undefined,
    event: event?.event
      ? {
          ...event.event,
          authorized: event.allowed,
          reasonCode: event.reasonCode,
        }
      : undefined,
    mentions: projectMentionFacts(activation),
  };
}

export function mapChannelIngressDecisionToTurnAdmission(
  decision: ChannelIngressDecision,
  sideEffect: ChannelIngressSideEffectResult,
): ChannelTurnAdmission {
  if (decision.admission === "dispatch") {
    return { kind: "dispatch", reason: decision.reasonCode };
  }
  if (decision.admission === "observe") {
    return { kind: "observeOnly", reason: decision.reasonCode };
  }
  if (decision.admission === "pairing-required") {
    return sideEffect.kind === "pairing-reply-sent"
      ? { kind: "handled", reason: decision.reasonCode }
      : { kind: "drop", reason: decision.reasonCode };
  }
  if (decision.admission === "skip") {
    return sideEffect.kind === "pending-history-recorded" ||
      sideEffect.kind === "local-event-handled" ||
      sideEffect.kind === "command-reply-sent"
      ? { kind: "handled", reason: decision.reasonCode }
      : { kind: "drop", reason: decision.reasonCode, recordHistory: false };
  }
  return sideEffect.kind === "local-event-handled" || sideEffect.kind === "command-reply-sent"
    ? { kind: "handled", reason: decision.reasonCode }
    : { kind: "drop", reason: decision.reasonCode };
}

export function createChannelIngressPluginId(id: string): ChannelIngressPluginId {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Channel ingress plugin id must be non-empty.");
  }
  return trimmed as ChannelIngressPluginId;
}

export function createChannelIngressSubject(
  input:
    | ChannelIngressSubjectIdentifierInput
    | { identifiers: readonly ChannelIngressSubjectIdentifierInput[] },
): ChannelIngressSubject {
  const identifiers = "identifiers" in input ? input.identifiers : [input];
  return {
    identifiers: identifiers.map((identifier, index) => ({
      opaqueId: identifier.opaqueId ?? `subject-${index + 1}`,
      kind: identifier.kind ?? "stable-id",
      value: identifier.value,
      dangerous: identifier.dangerous,
      sensitivity: identifier.sensitivity,
    })),
  };
}

export function createChannelIngressStringAdapter(
  params: CreateChannelIngressStringAdapterParams = {},
): ChannelIngressAdapter {
  const kind = params.kind ?? "stable-id";
  const normalizeEntry = params.normalizeEntry ?? defaultNormalize;
  const normalizeSubject = params.normalizeSubject ?? normalizeEntry;
  const isWildcardEntry = params.isWildcardEntry ?? ((entry: string) => entry === "*");
  return {
    normalizeEntries({ entries }) {
      const matchable = normalizeStringEntries(entries).flatMap((entry, index) => {
        const value = isWildcardEntry(entry) ? "*" : normalizeMatchValue(entry, normalizeEntry);
        if (!value) {
          return [];
        }
        return [
          {
            opaqueEntryId: params.resolveEntryId?.({ entry, index }) ?? `entry-${index + 1}`,
            kind,
            value,
            dangerous: resolveDangerous(params.dangerous, entry),
            sensitivity: params.sensitivity,
          },
        ];
      });
      return {
        matchable,
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries }) {
      const values = new Set(
        subject.identifiers.flatMap((identifier) => {
          if (identifier.kind !== kind) {
            return [];
          }
          const value = normalizeMatchValue(identifier.value, normalizeSubject);
          return value ? [value] : [];
        }),
      );
      const matchedEntryIds = entries
        .filter((entry) => entry.kind === kind && (entry.value === "*" || values.has(entry.value)))
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

export function createChannelIngressMultiIdentifierAdapter(
  params: CreateChannelIngressMultiIdentifierAdapterParams,
): ChannelIngressAdapter {
  const getEntryMatchKey = params.getEntryMatchKey ?? defaultIngressMatchKey;
  const getSubjectMatchKeys =
    params.getSubjectMatchKeys ??
    ((identifier: ChannelIngressSubjectIdentifier) => [defaultIngressMatchKey(identifier)]);
  const isWildcardEntry = params.isWildcardEntry ?? ((entry) => entry.value === "*");
  return {
    normalizeEntries({ entries }) {
      return {
        matchable: entries.flatMap((entry, index) => params.normalizeEntry(entry, index)),
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries }) {
      const subjectKeys = new Set(
        subject.identifiers.flatMap((identifier) =>
          getSubjectMatchKeys(identifier).filter((key): key is string => Boolean(key)),
        ),
      );
      const matchedEntryIds = entries
        .filter((entry) => {
          if (isWildcardEntry(entry)) {
            return true;
          }
          const key = getEntryMatchKey(entry);
          return key ? subjectKeys.has(key) : false;
        })
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

export function assertNeverChannelIngressReason(reasonCode: never): never {
  throw new Error(`Unhandled channel ingress reason code: ${String(reasonCode)}`);
}

/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)` or typed gate selectors. */
export function findChannelIngressSenderReasonCode(
  decision: ChannelIngressDecision,
  params: { isGroup: boolean },
): IngressReasonCode {
  return findChannelIngressSenderGate(decision, params)?.reasonCode ?? decision.reasonCode;
}

/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)`. */
export function mapChannelIngressReasonCodeToDmGroupAccessReason(params: {
  reasonCode: IngressReasonCode;
  isGroup: boolean;
}): DmGroupAccessReasonCode {
  switch (params.reasonCode) {
    case "group_policy_open":
    case "group_policy_allowed":
      return "group_policy_allowed";
    case "group_policy_disabled":
      return "group_policy_disabled";
    case "route_sender_empty":
    case "group_policy_empty_allowlist":
      return "group_policy_empty_allowlist";
    case "group_policy_not_allowlisted":
      return "group_policy_not_allowlisted";
    case "dm_policy_open":
      return "dm_policy_open";
    case "dm_policy_disabled":
      return "dm_policy_disabled";
    case "dm_policy_allowlisted":
      return "dm_policy_allowlisted";
    case "dm_policy_pairing_required":
      return "dm_policy_pairing_required";
    default:
      return params.isGroup ? "group_policy_not_allowlisted" : "dm_policy_not_allowlisted";
  }
}

/** @deprecated Use `senderAccess.reason` from `resolveChannelMessageIngress(...)`. */
export function formatChannelIngressPolicyReason(params: {
  reasonCode: DmGroupAccessReasonCode;
  dmPolicy: string;
  groupPolicy: string;
}): string {
  switch (params.reasonCode) {
    case "group_policy_allowed":
      return `groupPolicy=${params.groupPolicy}`;
    case "group_policy_disabled":
      return "groupPolicy=disabled";
    case "group_policy_empty_allowlist":
      return "groupPolicy=allowlist (empty allowlist)";
    case "group_policy_not_allowlisted":
      return "groupPolicy=allowlist (not allowlisted)";
    case "dm_policy_open":
      return "dmPolicy=open";
    case "dm_policy_disabled":
      return "dmPolicy=disabled";
    case "dm_policy_allowlisted":
      return `dmPolicy=${params.dmPolicy} (allowlisted)`;
    case "dm_policy_pairing_required":
      return "dmPolicy=pairing (not allowlisted)";
    case "dm_policy_not_allowlisted":
      return `dmPolicy=${params.dmPolicy} (not allowlisted)`;
  }
  const exhaustive: never = params.reasonCode;
  return exhaustive;
}

/** @deprecated Use `senderAccess.groupAccess` from `resolveChannelMessageIngress(...)`. */
export function projectChannelIngressSenderGroupAccess(params: {
  reasonCode: IngressReasonCode;
  decisionAllowed: boolean;
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  providerMissingFallbackApplied?: boolean;
}): ChannelIngressSenderGroupAccessProjection {
  const reasonCode = mapChannelIngressReasonCodeToDmGroupAccessReason({
    reasonCode: params.reasonCode,
    isGroup: true,
  });
  const reason =
    params.groupPolicy === "disabled" || reasonCode === "group_policy_disabled"
      ? "disabled"
      : reasonCode === "group_policy_empty_allowlist"
        ? "empty_allowlist"
        : reasonCode === "group_policy_not_allowlisted"
          ? "sender_not_allowlisted"
          : "allowed";
  return {
    allowed: reason === "allowed" && params.decisionAllowed,
    groupPolicy: params.groupPolicy,
    providerMissingFallbackApplied: params.providerMissingFallbackApplied ?? false,
    reason,
  };
}

/** @deprecated Use `senderAccess` from `resolveChannelMessageIngress(...)`. */
export function projectChannelIngressDmGroupAccess(params: {
  ingress: ChannelIngressDecision;
  isGroup: boolean;
  dmPolicy: string;
  groupPolicy: string;
}): ChannelIngressDmGroupAccessProjection {
  const reasonCode = mapChannelIngressReasonCodeToDmGroupAccessReason({
    reasonCode: findChannelIngressSenderReasonCode(params.ingress, { isGroup: params.isGroup }),
    isGroup: params.isGroup,
  });
  const decision: DmGroupAccessDecision =
    reasonCode === "dm_policy_pairing_required"
      ? "pairing"
      : params.ingress.decision === "allow"
        ? "allow"
        : "block";
  const reason = formatChannelIngressPolicyReason({
    reasonCode,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
  });
  return {
    decision,
    reasonCode,
    reason,
  };
}

export async function resolveChannelIngressState(
  input: ChannelIngressStateInput,
): Promise<ChannelIngressState> {
  return await resolveChannelIngressStateInternal(input);
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function resolveChannelIngressAccess(
  params: ResolveChannelIngressAccessParams,
): Promise<ResolvedChannelIngressAccess> {
  const { policy, effectiveAllowFrom, effectiveGroupAllowFrom, ...stateInput } = params;
  const state = await resolveChannelIngressState(stateInput);
  const ingress = decideChannelIngress(state, policy);
  const isGroup = params.conversation.kind !== "direct";
  const senderReasonCode = findChannelIngressSenderReasonCode(ingress, { isGroup });
  const access = projectChannelIngressDmGroupAccess({
    ingress,
    isGroup,
    dmPolicy: policy.dmPolicy,
    groupPolicy: policy.groupPolicy,
  });
  const commandGate = findChannelIngressCommandGate(ingress);
  return {
    state,
    ingress,
    isGroup,
    senderReasonCode,
    access: {
      ...access,
      effectiveAllowFrom: [...(effectiveAllowFrom ?? [])],
      effectiveGroupAllowFrom: [...(effectiveGroupAllowFrom ?? [])],
    },
    commandAuthorized: commandGate?.allowed === true,
    shouldBlockControlCommand: commandGate?.command?.shouldBlockControlCommand === true,
  };
}
