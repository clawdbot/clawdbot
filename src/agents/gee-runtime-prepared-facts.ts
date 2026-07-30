import { isToolAllowedByPolicyName } from "./tool-policy-match.js";

export type GeeRuntimeToolPolicy = {
  allowedToolIds: string[];
  endpointIds: string[];
};

export type GeeRuntimeCompactionOwner = "openclaw" | "gee" | "provider" | "disabled";

export type GeeRuntimeCompactionPolicy = {
  owner: GeeRuntimeCompactionOwner;
  endpointIds: string[];
  hostCompactionIds: string[];
};

export type GeeRuntimeAuthEligibility = "ok" | "expired" | "missing" | "unresolved";

export type GeeRuntimeProviderAuthPolicy = {
  endpointIds: string[];
  modelRefs: string[];
  routingPolicyIds: string[];
  fallbackPolicyIds: string[];
  cooldownPolicyIds: string[];
  credentialRefs: string[];
  authEligibility: GeeRuntimeAuthEligibility;
};

export function resolveGeeRuntimeToolPolicy(
  preparedFacts?: Record<string, unknown>,
): GeeRuntimeToolPolicy | undefined {
  if (!preparedFacts || Object.keys(preparedFacts).length === 0) {
    return undefined;
  }

  const entries = Object.entries(preparedFacts);
  if (entries.length > 1) {
    const endpointIds = entries.map(([endpointId]) => endpointId).toSorted((left, right) =>
      left.localeCompare(right),
    );
    throw new Error(
      `Gee-hosted OpenClaw tool policy requires exactly one active endpoint; received endpoints "${endpointIds.join(
        '", "',
      )}".`,
    );
  }

  const endpointIds: string[] = [];
  const allowedToolIds = new Set<string>();
  for (const [endpointId, rawFact] of entries) {
    const fact = readGeeRuntimePreparedFact(rawFact, endpointId);
    const envelope = readRequiredRecord(fact.envelope, endpointId, "envelope");
    const tools = readRequiredRecord(envelope.tools, endpointId, "envelope.tools");
    readLiteral(tools.policy, "gee-authorized", endpointId, "envelope.tools.policy");
    for (const toolId of readStringArray(
      tools.allowedToolIds,
      endpointId,
      "envelope.tools.allowedToolIds",
    )) {
      allowedToolIds.add(toolId);
    }
    endpointIds.push(endpointId);
  }

  return {
    allowedToolIds: Array.from(allowedToolIds).toSorted((left, right) => left.localeCompare(right)),
    endpointIds: endpointIds.toSorted((left, right) => left.localeCompare(right)),
  };
}

export function resolveGeeRuntimeCompactionPolicy(
  preparedFacts?: Record<string, unknown>,
): GeeRuntimeCompactionPolicy | undefined {
  if (!preparedFacts || Object.keys(preparedFacts).length === 0) {
    return undefined;
  }

  const endpointIds: string[] = [];
  const hostCompactionIds = new Set<string>();
  const owners = new Set<GeeRuntimeCompactionOwner>();
  for (const [endpointId, rawFact] of Object.entries(preparedFacts)) {
    const fact = readGeeRuntimePreparedFact(rawFact, endpointId);
    const envelope = readRequiredRecord(fact.envelope, endpointId, "envelope");
    const compaction = readRequiredRecord(envelope.compaction, endpointId, "envelope.compaction");
    const owner = readEnum(
      compaction.owner,
      ["openclaw", "gee", "provider", "disabled"],
      endpointId,
      "envelope.compaction.owner",
    );
    owners.add(owner);
    const hostCompactionId = readOptionalString(
      compaction.hostCompactionId,
      endpointId,
      "envelope.compaction.hostCompactionId",
    );
    if (hostCompactionId) {
      hostCompactionIds.add(hostCompactionId);
    }
    endpointIds.push(endpointId);
  }

  if (owners.size > 1) {
    throw new Error(
      `Hosted OpenClaw prepared runtime facts have conflicting compaction owners for endpoints "${endpointIds
        .toSorted((left, right) => left.localeCompare(right))
        .join('", "')}".`,
    );
  }
  const [owner] = owners;
  if (!owner) {
    return undefined;
  }
  return {
    owner,
    endpointIds: endpointIds.toSorted((left, right) => left.localeCompare(right)),
    hostCompactionIds: Array.from(hostCompactionIds).toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export function resolveGeeRuntimeProviderAuthPolicy(
  preparedFacts?: Record<string, unknown>,
): GeeRuntimeProviderAuthPolicy | undefined {
  if (!preparedFacts || Object.keys(preparedFacts).length === 0) {
    return undefined;
  }

  const endpointIds: string[] = [];
  const modelRefs = new Set<string>();
  const routingPolicyIds = new Set<string>();
  const fallbackPolicyIds = new Set<string>();
  const cooldownPolicyIds = new Set<string>();
  const credentialRefs = new Set<string>();
  const authEligibilities = new Set<GeeRuntimeAuthEligibility>();
  for (const [endpointId, rawFact] of Object.entries(preparedFacts)) {
    const fact = readGeeRuntimePreparedFact(rawFact, endpointId);
    const envelope = readRequiredRecord(fact.envelope, endpointId, "envelope");
    const provider = readRequiredRecord(envelope.provider, endpointId, "envelope.provider");
    const auth = readRequiredRecord(envelope.auth, endpointId, "envelope.auth");
    modelRefs.add(readRequiredString(provider.modelRef, endpointId, "envelope.provider.modelRef"));
    routingPolicyIds.add(
      readRequiredString(provider.routingPolicyId, endpointId, "envelope.provider.routingPolicyId"),
    );
    const fallbackPolicyId = readOptionalString(
      provider.fallbackPolicyId,
      endpointId,
      "envelope.provider.fallbackPolicyId",
    );
    if (fallbackPolicyId) {
      fallbackPolicyIds.add(fallbackPolicyId);
    }
    const cooldownPolicyId = readOptionalString(
      provider.cooldownPolicyId,
      endpointId,
      "envelope.provider.cooldownPolicyId",
    );
    if (cooldownPolicyId) {
      cooldownPolicyIds.add(cooldownPolicyId);
    }
    credentialRefs.add(
      readRequiredString(auth.credentialRef, endpointId, "envelope.auth.credentialRef"),
    );
    authEligibilities.add(
      readEnum(
        auth.eligibility,
        ["ok", "expired", "missing", "unresolved"],
        endpointId,
        "envelope.auth.eligibility",
      ),
    );
    endpointIds.push(endpointId);
  }

  if (authEligibilities.size > 1) {
    throw new Error(
      `Hosted OpenClaw prepared runtime facts have conflicting auth eligibility states for endpoints "${endpointIds
        .toSorted((left, right) => left.localeCompare(right))
        .join('", "')}".`,
    );
  }
  const [authEligibility] = authEligibilities;
  if (!authEligibility) {
    return undefined;
  }
  const sortStrings = (values: Iterable<string>) =>
    Array.from(values).toSorted((left, right) => left.localeCompare(right));
  return {
    endpointIds: sortStrings(endpointIds),
    modelRefs: sortStrings(modelRefs),
    routingPolicyIds: sortStrings(routingPolicyIds),
    fallbackPolicyIds: sortStrings(fallbackPolicyIds),
    cooldownPolicyIds: sortStrings(cooldownPolicyIds),
    credentialRefs: sortStrings(credentialRefs),
    authEligibility,
  };
}

export function resolveGeeRuntimeToolAllowlist(
  policy: GeeRuntimeToolPolicy | undefined,
  fallbackAllowlist?: string[],
): string[] | undefined {
  return policy ? policy.allowedToolIds : fallbackAllowlist;
}

export function isGeeRuntimeToolAllowed(
  policy: GeeRuntimeToolPolicy | undefined,
  toolName: string,
): boolean {
  if (!policy) {
    return true;
  }
  if (policy.allowedToolIds.length === 0) {
    return false;
  }
  return isToolAllowedByPolicyName(toolName, { allow: policy.allowedToolIds });
}

function readGeeRuntimePreparedFact(value: unknown, endpointId: string): Record<string, unknown> {
  const fact = readRequiredRecord(value, endpointId, "preparedFacts");
  readLiteral(fact.kind, "gee-runtime-prepared-facts", endpointId, "kind");
  readLiteral(fact.version, 1, endpointId, "version");
  readLiteral(fact.hostMode, "gee-hosted", endpointId, "hostMode");
  return fact;
}

function readRequiredRecord(
  value: unknown,
  endpointId: string,
  fieldName: string,
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function readStringArray(value: unknown, endpointId: string, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throwInvalidPreparedFact(endpointId, fieldName);
  }
  return value.map((entry) => readRequiredString(entry, endpointId, fieldName));
}

function readRequiredString(value: unknown, endpointId: string, fieldName: string): string {
  const result = readOptionalString(value, endpointId, fieldName);
  if (result) {
    return result;
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function readOptionalString(
  value: unknown,
  endpointId: string,
  fieldName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function readLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  endpointId: string,
  fieldName: string,
): T {
  if (value === expected) {
    return expected;
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function readEnum<T extends string>(
  value: unknown,
  options: readonly T[],
  endpointId: string,
  fieldName: string,
): T {
  if (typeof value === "string" && options.includes(value as T)) {
    return value as T;
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function throwInvalidPreparedFact(endpointId: string, fieldName: string): never {
  throw new Error(
    `Gee-hosted OpenClaw endpoint "${endpointId}" has invalid prepared runtime fact "${fieldName}".`,
  );
}
