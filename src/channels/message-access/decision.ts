import { resolveCommandAuthorizedFromAuthorizers } from "../command-gating.js";
import { resolveInboundMentionDecision } from "../mention-gating.js";
import { applyMutableIdentifierPolicy, redactedAllowlistDiagnostics } from "./allowlist.js";
import {
  applyEventAuthModeToSenderGate,
  senderGateForDirect,
  senderGateForGroup,
} from "./sender-gates.js";
import type {
  AccessGraphGate,
  ChannelIngressDecision,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  RedactedIngressMatch,
} from "./types.js";

function decisiveDecision(params: {
  admission: ChannelIngressDecision["admission"];
  decision: ChannelIngressDecision["decision"];
  gate: AccessGraphGate;
  gates: AccessGraphGate[];
}): ChannelIngressDecision {
  return {
    admission: params.admission,
    decision: params.decision,
    decisiveGateId: params.gate.id,
    reasonCode: params.gate.reasonCode,
    graph: { gates: params.gates },
  };
}

function routeGates(state: ChannelIngressState): AccessGraphGate[] {
  return state.routeFacts.map((route) => ({
    id: route.id,
    phase: "route",
    kind: route.kind,
    effect: route.effect,
    allowed: route.effect !== "block-dispatch",
    reasonCode: route.effect === "block-dispatch" ? "route_blocked" : "allowed",
    match: route.match,
  }));
}

function routeSenderEmptyGate(state: ChannelIngressState): AccessGraphGate | null {
  const route = state.routeFacts.find(
    (fact) =>
      fact.senderPolicy === "deny-when-empty" &&
      fact.gate === "matched" &&
      fact.senderAllowlist?.hasConfiguredEntries !== true,
  );
  if (!route) {
    return null;
  }
  const reasonCode = "route_sender_empty";
  return {
    id: `${route.id}:sender`,
    phase: "route",
    kind: "routeSender",
    effect: "block-dispatch",
    allowed: false,
    reasonCode,
    match: route.match,
    allowlist: route.senderAllowlist
      ? redactedAllowlistDiagnostics(route.senderAllowlist, reasonCode)
      : undefined,
  };
}

function commandGate(params: {
  state: ChannelIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const command = params.policy.command;
  if (!command) {
    return {
      id: "command",
      phase: "command",
      kind: "command",
      effect: "allow",
      allowed: true,
      reasonCode: "command_authorized",
    };
  }
  const useAccessGroups = command.useAccessGroups ?? true;
  const owner = applyMutableIdentifierPolicy(params.state.allowlists.commandOwner, params.policy);
  const group = applyMutableIdentifierPolicy(params.state.allowlists.commandGroup, params.policy);
  const authorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    modeWhenAccessGroupsOff: command.modeWhenAccessGroupsOff,
    authorizers: [
      { configured: owner.hasConfiguredEntries, allowed: owner.match.matched },
      { configured: group.hasConfiguredEntries, allowed: group.match.matched },
    ],
  });
  const shouldBlock = command.allowTextCommands && command.hasControlCommand && !authorized;
  return {
    id: "command",
    phase: "command",
    kind: "command",
    effect: shouldBlock ? "block-command" : "allow",
    allowed: authorized,
    reasonCode: shouldBlock ? "control_command_unauthorized" : "command_authorized",
    match: mergeCommandMatch(owner.match, group.match),
    command: {
      useAccessGroups,
      allowTextCommands: command.allowTextCommands,
      modeWhenAccessGroupsOff: command.modeWhenAccessGroupsOff,
      shouldBlockControlCommand: shouldBlock,
    },
  };
}

function mergeCommandMatch(
  owner: RedactedIngressMatch,
  group: RedactedIngressMatch,
): RedactedIngressMatch {
  const matchedEntryIds = Array.from(new Set([...owner.matchedEntryIds, ...group.matchedEntryIds]));
  return {
    matched: owner.matched || group.matched || matchedEntryIds.length > 0,
    matchedEntryIds,
  };
}

function eventGate(params: {
  state: ChannelIngressState;
  senderGate: AccessGraphGate;
  commandGate: AccessGraphGate;
}): AccessGraphGate {
  const authMode = params.state.event.authMode;
  const event = params.state.event;
  const eventResult = (
    allowed: boolean,
    reasonCode: AccessGraphGate["reasonCode"],
  ): AccessGraphGate => ({
    id: "event",
    phase: "event",
    kind: "event",
    effect: allowed ? "allow" : "block-dispatch",
    allowed,
    reasonCode,
    event,
  });
  if (authMode === "none" || authMode === "route-only") {
    return eventResult(true, "event_authorized");
  }
  if (authMode === "command") {
    return eventResult(
      params.commandGate.allowed,
      params.commandGate.allowed ? "event_authorized" : "event_unauthorized",
    );
  }
  if (authMode === "origin-subject") {
    if (!params.state.event.hasOriginSubject) {
      return eventResult(false, "origin_subject_missing");
    }
    const matched = params.state.event.originSubjectMatched;
    return eventResult(matched, matched ? "event_authorized" : "origin_subject_not_matched");
  }
  return eventResult(
    params.senderGate.allowed,
    params.senderGate.allowed ? "event_authorized" : "event_unauthorized",
  );
}

function activationMetadata(params: {
  activation?: ChannelIngressPolicyInput["activation"];
  mentionFacts: ChannelIngressState["mentionFacts"];
  shouldSkip: boolean;
  effectiveWasMentioned?: boolean;
  shouldBypassMention?: boolean;
}) {
  const mentionFacts = params.mentionFacts;
  return {
    hasMentionFacts: mentionFacts != null,
    requireMention: params.activation?.requireMention ?? false,
    allowTextCommands: params.activation?.allowTextCommands ?? false,
    ...(params.activation?.allowedImplicitMentionKinds !== undefined
      ? { allowedImplicitMentionKinds: params.activation.allowedImplicitMentionKinds }
      : {}),
    ...(params.activation?.order ? { order: params.activation.order } : {}),
    shouldSkip: params.shouldSkip,
    ...(mentionFacts?.canDetectMention !== undefined
      ? { canDetectMention: mentionFacts.canDetectMention }
      : {}),
    ...(mentionFacts?.wasMentioned !== undefined
      ? { wasMentioned: mentionFacts.wasMentioned }
      : {}),
    ...(mentionFacts?.hasAnyMention !== undefined
      ? { hasAnyMention: mentionFacts.hasAnyMention }
      : {}),
    ...(mentionFacts?.implicitMentionKinds !== undefined
      ? { implicitMentionKinds: mentionFacts.implicitMentionKinds }
      : {}),
    ...(params.effectiveWasMentioned !== undefined
      ? { effectiveWasMentioned: params.effectiveWasMentioned }
      : {}),
    ...(params.shouldBypassMention !== undefined
      ? { shouldBypassMention: params.shouldBypassMention }
      : {}),
  };
}

function activationGate(params: {
  state: ChannelIngressState;
  policy: ChannelIngressPolicyInput;
  commandGate: AccessGraphGate;
}): AccessGraphGate {
  const activation = params.policy.activation;
  const mentionFacts = params.state.mentionFacts;
  const activationResult = (input: {
    shouldSkip: boolean;
    effectiveWasMentioned?: boolean;
    shouldBypassMention?: boolean;
  }): AccessGraphGate => ({
    id: "activation",
    phase: "activation",
    kind: "mention",
    effect: input.shouldSkip ? "skip" : "allow",
    allowed: !input.shouldSkip,
    reasonCode: input.shouldSkip ? "activation_skipped" : "activation_allowed",
    activation: activationMetadata({
      activation,
      mentionFacts,
      shouldSkip: input.shouldSkip,
      effectiveWasMentioned: input.effectiveWasMentioned,
      shouldBypassMention: input.shouldBypassMention,
    }),
  });
  if (!activation || !mentionFacts) {
    return activationResult({
      shouldSkip: false,
      effectiveWasMentioned:
        mentionFacts &&
        (mentionFacts.wasMentioned || Boolean(mentionFacts.implicitMentionKinds?.length)),
    });
  }
  const result = resolveInboundMentionDecision({
    facts: mentionFacts,
    policy: {
      isGroup: params.state.conversationKind !== "direct",
      requireMention: activation.requireMention,
      allowedImplicitMentionKinds: activation.allowedImplicitMentionKinds,
      allowTextCommands: activation.allowTextCommands,
      hasControlCommand: params.policy.command?.hasControlCommand ?? false,
      commandAuthorized: params.commandGate.allowed,
    },
  });
  return activationResult({
    shouldSkip: result.shouldSkip,
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldBypassMention: result.shouldBypassMention,
  });
}

export function decideChannelIngress(
  state: ChannelIngressState,
  policy: ChannelIngressPolicyInput,
): ChannelIngressDecision {
  const gates: AccessGraphGate[] = routeGates(state);
  const emptyRouteSenderGate = routeSenderEmptyGate(state);
  if (emptyRouteSenderGate) {
    gates.push(emptyRouteSenderGate);
  }
  const routeBlock = gates.find((entry) => entry.effect === "block-dispatch");
  if (routeBlock) {
    return decisiveDecision({ admission: "drop", decision: "block", gate: routeBlock, gates });
  }

  const activationBeforeSender =
    policy.activation?.order === "before-sender" && !policy.activation.allowTextCommands
      ? activationGate({
          state,
          policy,
          commandGate: commandGate({ state, policy: { ...policy, command: undefined } }),
        })
      : null;
  if (activationBeforeSender) {
    gates.push(activationBeforeSender);
    if (activationBeforeSender.effect === "skip") {
      return decisiveDecision({
        admission: "skip",
        decision: "allow",
        gate: activationBeforeSender,
        gates,
      });
    }
  }

  const sender =
    state.conversationKind === "direct"
      ? senderGateForDirect({ state, policy })
      : senderGateForGroup({ state, policy });
  const eventModeSender = applyEventAuthModeToSenderGate({ state, senderGate: sender });
  gates.push(eventModeSender);
  if (!eventModeSender.allowed) {
    const admission =
      eventModeSender.reasonCode === "dm_policy_pairing_required" ? "pairing-required" : "drop";
    const decision =
      eventModeSender.reasonCode === "dm_policy_pairing_required" ? "pairing" : "block";
    return decisiveDecision({ admission, decision, gate: eventModeSender, gates });
  }

  const command = commandGate({ state, policy });
  gates.push(command);
  if (command.effect === "block-command") {
    return decisiveDecision({ admission: "drop", decision: "block", gate: command, gates });
  }

  const event = eventGate({ state, senderGate: eventModeSender, commandGate: command });
  gates.push(event);
  if (!event.allowed) {
    return decisiveDecision({ admission: "drop", decision: "block", gate: event, gates });
  }

  const activation =
    activationBeforeSender ?? activationGate({ state, policy, commandGate: command });
  if (!activationBeforeSender) {
    gates.push(activation);
  }
  if (activation.effect === "skip") {
    return decisiveDecision({ admission: "skip", decision: "allow", gate: activation, gates });
  }
  if (activation.effect === "observe") {
    return decisiveDecision({ admission: "observe", decision: "allow", gate: activation, gates });
  }
  return decisiveDecision({ admission: "dispatch", decision: "allow", gate: activation, gates });
}
