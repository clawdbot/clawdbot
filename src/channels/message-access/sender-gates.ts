import {
  allowlistFailureReason,
  applyMutableIdentifierPolicy,
  effectiveGroupSenderAllowlist,
  redactedAllowlistDiagnostics,
} from "./allowlist.js";
import type {
  AccessGraphGate,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ResolvedIngressAllowlist,
} from "./types.js";

function senderGate(params: {
  id: "sender:dm" | "sender:group";
  kind: "dmSender" | "groupSender";
  effect: AccessGraphGate["effect"];
  allowed: boolean;
  reasonCode: AccessGraphGate["reasonCode"];
  match: AccessGraphGate["match"];
  policy: ChannelIngressPolicyInput["dmPolicy"] | ChannelIngressPolicyInput["groupPolicy"];
  allowlistSource: ResolvedIngressAllowlist;
}): AccessGraphGate {
  return {
    id: params.id,
    phase: "sender",
    kind: params.kind,
    effect: params.effect,
    allowed: params.allowed,
    reasonCode: params.reasonCode,
    match: params.match,
    sender: { policy: params.policy },
    allowlist: redactedAllowlistDiagnostics(params.allowlistSource, params.reasonCode),
  };
}

export function senderGateForDirect(params: {
  state: ChannelIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const dm = applyMutableIdentifierPolicy(params.state.allowlists.dm, params.policy);
  const pairingStore = applyMutableIdentifierPolicy(
    params.state.allowlists.pairingStore,
    params.policy,
  );
  const base = {
    policy: params.policy.dmPolicy,
    allowlistSource: dm,
    match: dm.match,
  };
  const allow = (reasonCode: AccessGraphGate["reasonCode"]) =>
    senderGate({
      id: "sender:dm",
      kind: "dmSender",
      ...base,
      effect: "allow",
      allowed: true,
      reasonCode,
    });
  const block = (reasonCode: AccessGraphGate["reasonCode"]) =>
    senderGate({
      id: "sender:dm",
      kind: "dmSender",
      ...base,
      effect: "block-dispatch",
      allowed: false,
      reasonCode,
    });
  if (params.policy.dmPolicy === "disabled") {
    return block("dm_policy_disabled");
  }
  if (params.policy.dmPolicy === "open") {
    if (dm.hasWildcard) {
      return allow("dm_policy_open");
    }
    if (dm.match.matched) {
      return allow("dm_policy_allowlisted");
    }
    return block("dm_policy_not_allowlisted");
  }
  if (dm.match.matched) {
    return allow("dm_policy_allowlisted");
  }
  if (params.policy.dmPolicy === "pairing" && pairingStore.match.matched) {
    return senderGate({
      id: "sender:dm",
      kind: "dmSender",
      effect: "allow",
      allowed: true,
      reasonCode: "dm_policy_allowlisted",
      match: pairingStore.match,
      policy: params.policy.dmPolicy,
      allowlistSource: pairingStore,
    });
  }
  if (params.policy.dmPolicy === "pairing" && params.state.event.mayPair) {
    return block("dm_policy_pairing_required");
  }
  const reasonCode =
    params.policy.dmPolicy === "pairing"
      ? "event_pairing_not_allowed"
      : (allowlistFailureReason(dm) ?? "dm_policy_not_allowlisted");
  return block(reasonCode);
}

export function senderGateForGroup(params: {
  state: ChannelIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const group = effectiveGroupSenderAllowlist(params);
  const base = {
    policy: params.policy.groupPolicy,
    allowlistSource: group,
    match: group.match,
  };
  const allow = (reasonCode: AccessGraphGate["reasonCode"]) =>
    senderGate({
      id: "sender:group",
      kind: "groupSender",
      ...base,
      effect: "allow",
      allowed: true,
      reasonCode,
    });
  const block = (reasonCode: AccessGraphGate["reasonCode"]) =>
    senderGate({
      id: "sender:group",
      kind: "groupSender",
      ...base,
      effect: "block-dispatch",
      allowed: false,
      reasonCode,
    });
  if (params.policy.groupPolicy === "disabled") {
    return block("group_policy_disabled");
  }
  if (params.policy.groupPolicy === "open") {
    return allow("group_policy_open");
  }
  if (!group.hasConfiguredEntries) {
    return block("group_policy_empty_allowlist");
  }
  if (group.match.matched) {
    return allow("group_policy_allowed");
  }
  return block(allowlistFailureReason(group) ?? "group_policy_not_allowlisted");
}

export function applyEventAuthModeToSenderGate(params: {
  state: ChannelIngressState;
  senderGate: AccessGraphGate;
}): AccessGraphGate {
  if (params.state.event.authMode === "inbound" || params.senderGate.allowed) {
    return params.senderGate;
  }
  const reasonCode = "sender_not_required";
  return {
    ...params.senderGate,
    effect: "ignore",
    allowed: true,
    reasonCode,
    allowlist: params.senderGate.allowlist
      ? { ...params.senderGate.allowlist, reasonCode }
      : undefined,
  };
}
