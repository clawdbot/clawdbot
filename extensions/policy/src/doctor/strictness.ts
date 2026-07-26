// Policy doctor strictness comparisons for scoped policy overlays.
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeAccountId, normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { ROUTING_MATCH_KINDS } from "../policy-routing.js";
import { expandPolicyToolRequirement, toolListCoversTool } from "../tool-policy-conformance.js";
import type { PolicyRuleMetadata } from "./metadata.js";

type ExecApprovalAllowlistRequirement = {
  readonly key: string;
  readonly pattern: string;
  readonly argPattern?: string;
};

export function isPolicyValueAtLeastAsStrict(
  metadata: PolicyRuleMetadata,
  candidate: unknown,
  baseline: unknown,
): boolean {
  switch (metadata.strictness) {
    case "allowlist-subset":
      return isPolicyAllowlistSubset(metadata, candidate, baseline);
    case "denylist-superset":
      return isPolicyDenylistSuperset(metadata, candidate, baseline);
    case "ordered-string":
      return isPolicyOrderedStringAtLeastAsStrict(metadata, candidate, baseline);
    case "requires-true":
      return baseline !== true || candidate === true;
    case "requires-false":
      return baseline !== false || candidate === false;
    case "exact-list":
      return samePolicyStringList(candidate, baseline, metadata);
    case "routing-probes":
      return routingProbesAtLeastAsStrict(candidate, baseline);
  }
  return false;
}

function routingProbesAtLeastAsStrict(candidate: unknown, baseline: unknown): boolean {
  if (!Array.isArray(candidate) || !Array.isArray(baseline)) {
    return false;
  }
  const candidateById = new Map<string, Record<string, unknown>>();
  for (const entry of candidate) {
    if (!isRecord(entry) || !nonEmptyString(entry.id) || candidateById.has(entry.id)) {
      return false;
    }
    candidateById.set(entry.id, entry);
  }
  return baseline.every((baselineEntry) => {
    if (!isRecord(baselineEntry) || !nonEmptyString(baselineEntry.id)) {
      return false;
    }
    const candidateEntry = candidateById.get(baselineEntry.id);
    if (!isRecord(candidateEntry)) {
      return false;
    }
    const candidateRoute = canonicalRoutingRoute(candidateEntry.route);
    const baselineRoute = canonicalRoutingRoute(baselineEntry.route);
    if (
      candidateRoute === undefined ||
      baselineRoute === undefined ||
      candidateRoute !== baselineRoute ||
      !isRecord(candidateEntry.expect) ||
      !isRecord(baselineEntry.expect) ||
      !nonEmptyString(candidateEntry.expect.agentId) ||
      !nonEmptyString(baselineEntry.expect.agentId) ||
      normalizeAgentId(candidateEntry.expect.agentId) !==
        normalizeAgentId(baselineEntry.expect.agentId)
    ) {
      return false;
    }
    return routingMatchKindsAtLeastAsStrict(
      candidateEntry.expect.matchedBy,
      baselineEntry.expect.matchedBy,
    );
  });
}

function routingMatchKindsAtLeastAsStrict(candidate: unknown, baseline: unknown): boolean {
  if (baseline === undefined) {
    return candidate === undefined || validRoutingMatchKinds(candidate);
  }
  if (!validRoutingMatchKinds(candidate) || !validRoutingMatchKinds(baseline)) {
    return false;
  }
  const baselineKinds = new Set(baseline);
  return candidate.every((entry) => baselineKinds.has(entry));
}

function validRoutingMatchKinds(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) => typeof entry === "string" && ROUTING_MATCH_KINDS.includes(entry as never),
    ) &&
    new Set(value).size === value.length
  );
}

function canonicalRoutingRoute(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "accountId",
          "channel",
          "guildId",
          "memberRoleIds",
          "parentPeer",
          "peer",
          "teamId",
        ].includes(key),
    ) ||
    !nonEmptyString(value.channel) ||
    [value.accountId, value.guildId, value.teamId].some(
      (entry) => entry !== undefined && !nonEmptyString(entry),
    )
  ) {
    return undefined;
  }
  const peer = canonicalRoutingPeer(value.peer);
  const parentPeer = canonicalRoutingPeer(value.parentPeer);
  if (peer === null || parentPeer === null) {
    return undefined;
  }
  const memberRoleIds = value.memberRoleIds;
  if (
    memberRoleIds !== undefined &&
    (!Array.isArray(memberRoleIds) ||
      memberRoleIds.length === 0 ||
      memberRoleIds.some((entry) => !nonEmptyString(entry)) ||
      new Set(memberRoleIds).size !== memberRoleIds.length)
  ) {
    return undefined;
  }
  return JSON.stringify({
    channel: normalizeLowercaseStringOrEmpty(value.channel),
    // Probe account ids are inbound values, not binding patterns, so "*" follows
    // resolveAgentRoute and normalizes to the default account rather than a wildcard.
    accountId: normalizeAccountId(value.accountId as string | undefined),
    peer,
    parentPeer,
    guildId: normalizeRoutingId(value.guildId),
    teamId: normalizeRoutingId(value.teamId),
    memberRoleIds: memberRoleIds?.toSorted(),
  });
}

function canonicalRoutingPeer(value: unknown): object | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "id" && key !== "kind") ||
    !(["channel", "direct", "group"] as const).includes(value.kind as never) ||
    !nonEmptyString(value.id)
  ) {
    return null;
  }
  return { kind: value.kind, id: value.id.trim() };
}

function normalizeRoutingId(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPolicyOrderedStringAtLeastAsStrict(
  metadata: PolicyRuleMetadata,
  candidate: unknown,
  baseline: unknown,
): boolean {
  const candidateValue = policyString(candidate, metadata);
  const baselineValue = policyString(baseline, metadata);
  if (
    candidateValue === undefined ||
    baselineValue === undefined ||
    metadata.orderedValues === undefined
  ) {
    return false;
  }
  const orderedValues = metadata.orderedValues.map((entry) =>
    metadata.caseSensitive === true ? entry : entry.toLowerCase(),
  );
  const candidateIndex = orderedValues.indexOf(candidateValue);
  const baselineIndex = orderedValues.indexOf(baselineValue);
  return candidateIndex >= 0 && baselineIndex >= 0 && candidateIndex >= baselineIndex;
}

function isPolicyAllowlistSubset(
  metadata: PolicyRuleMetadata,
  candidate: unknown,
  baseline: unknown,
): boolean {
  const candidateList = policyStringList(candidate, metadata);
  const baselineList = policyStringList(baseline, metadata);
  if (candidateList === undefined || baselineList === undefined) {
    return false;
  }
  if (metadata.emptyList === "disabled" && baselineList.length === 0) {
    return true;
  }
  if (metadata.emptyList === "disabled" && baselineList.length > 0 && candidateList.length === 0) {
    return false;
  }
  const allowed = new Set(baselineList);
  return candidateList.every((entry) => allowed.has(entry));
}

function isPolicyDenylistSuperset(
  metadata: PolicyRuleMetadata,
  candidate: unknown,
  baseline: unknown,
): boolean {
  const candidateList = policyStringList(candidate, metadata);
  const baselineList = policyStringList(baseline, metadata);
  if (candidateList === undefined || baselineList === undefined) {
    return false;
  }
  if (metadata.policyPath.join(".") === "tools.denyTools") {
    return baselineList
      .flatMap(expandPolicyToolRequirement)
      .every((tool) => toolListCoversTool(candidateList, tool));
  }
  const denied = new Set(candidateList);
  return baselineList.every((entry) => denied.has(entry));
}

function samePolicyStringList(
  candidate: unknown,
  baseline: unknown,
  metadata: PolicyRuleMetadata,
): boolean {
  const candidateList = policyStringList(candidate, metadata);
  const baselineList = policyStringList(baseline, metadata);
  if (candidateList === undefined || baselineList === undefined) {
    return false;
  }
  const candidateSorted = candidateList.toSorted();
  const baselineSorted = baselineList.toSorted();
  return (
    candidateSorted.length === baselineSorted.length &&
    candidateSorted.every((entry, index) => entry === baselineSorted[index])
  );
}

function policyStringList(
  value: unknown,
  metadata: PolicyRuleMetadata,
): readonly string[] | undefined {
  if (metadata.valueType === "channel-provider-deny-rules") {
    return channelProviderDenyRuleList(value, metadata);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (metadata.policyPath.join(".") === "execApprovals.agents.allowlist.expected") {
    const entries = value.map(execApprovalAllowlistRequirement);
    if (!entries.every((entry): entry is ExecApprovalAllowlistRequirement => entry !== undefined)) {
      return undefined;
    }
    return entries.map((entry) => entry.key);
  }
  if (!value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizePolicyStringListEntry(entry, metadata));
}

function normalizePolicyStringListEntry(entry: string, metadata: PolicyRuleMetadata): string {
  if (metadata.normalizeValues === "model-provider") {
    return normalizeProviderId(entry);
  }
  return metadata.caseSensitive === true ? entry : entry.toLowerCase();
}

function channelProviderDenyRuleList(
  value: unknown,
  metadata: PolicyRuleMetadata,
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const providers: string[] = [];
  for (const entry of value) {
    if (!isChannelDenyRule(entry)) {
      return undefined;
    }
    const provider = entry.when?.provider?.trim();
    if (provider !== undefined && provider !== "") {
      providers.push(metadata.caseSensitive === true ? provider : provider.toLowerCase());
    }
  }
  return providers;
}

function policyString(value: unknown, metadata: PolicyRuleMetadata): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  return metadata.caseSensitive === true ? trimmed : trimmed.toLowerCase();
}

function execApprovalAllowlistRequirement(
  value: unknown,
): ExecApprovalAllowlistRequirement | undefined {
  if (typeof value === "string") {
    const pattern = value.trim();
    return pattern === "" ? undefined : execApprovalAllowlistRequirementFromParts(pattern);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "argPattern" && key !== "pattern")) {
    return undefined;
  }
  const pattern = typeof value.pattern === "string" ? value.pattern.trim() : "";
  if (pattern === "") {
    return undefined;
  }
  const argPattern = typeof value.argPattern === "string" ? value.argPattern.trim() : undefined;
  if (value.argPattern !== undefined && argPattern === undefined) {
    return undefined;
  }
  return execApprovalAllowlistRequirementFromParts(
    pattern,
    argPattern === "" ? undefined : argPattern,
  );
}

function execApprovalAllowlistRequirementFromParts(
  pattern: string,
  argPattern?: string,
): ExecApprovalAllowlistRequirement {
  return {
    key: execApprovalAllowlistRequirementKey(pattern, argPattern),
    pattern,
    ...(argPattern === undefined ? {} : { argPattern }),
  };
}

function execApprovalAllowlistRequirementKey(
  pattern: string,
  argPattern: string | undefined,
): string {
  return `${pattern}\0${argPattern ?? ""}`;
}

function isChannelDenyRule(value: unknown): value is {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
} {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    isRecord(value.when) &&
    typeof value.when.provider === "string"
  );
}
