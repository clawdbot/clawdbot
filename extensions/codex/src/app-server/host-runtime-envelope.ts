import crypto from "node:crypto";
import type { TurnOwnerDecision } from "./mcp-thread-config.js";
import type { JsonObject, JsonValue } from "./protocol.js";

export type HostRuntimeEnvelope = {
  kind: "host-runtime-envelope";
  version: 1;
  owner: "external-host";
  hostId: string;
  requestId: string;
  auditId: string;
  endpoint: {
    channel: string;
    accountId?: string;
    endpointId: string;
    externalIdentity: string;
  };
  conversation: {
    sessionKey: string;
    threadId?: string;
    threadOwner: "external-host";
  };
  provider: {
    modelRef: string;
    routingPolicyId: string;
    fallbackPolicyId?: string;
    cooldownPolicyId?: string;
  };
  auth: {
    credentialRef: string;
    eligibility: "ok" | "expired" | "missing" | "unresolved";
  };
  tools: {
    capabilityPlanId: string;
    allowedToolIds: string[];
    policy: "host-authorized";
  };
  delivery: {
    policyId: string;
    accountId?: string;
    outboundTarget: string;
    confirmationPolicy?: string;
  };
  compaction: {
    owner: "openclaw" | "external-host" | "provider" | "disabled";
    hostCompactionId?: string;
  };
};

export type HostRuntimePreparedFacts = {
  kind: "host-runtime-prepared-facts";
  version: 1;
  hostMode: "external-hosted";
  envelope: HostRuntimeEnvelope;
};

export type HostRuntimePreparedFactsBuild = {
  preparedFacts?: Record<string, HostRuntimePreparedFacts>;
  fingerprint?: string;
  serialized?: JsonObject;
};

export type HostRuntimeEnvelopeValidationErrorCode =
  | "openclaw_host_runtime_conflict"
  | "openclaw_host_runtime_invalid"
  | "openclaw_host_runtime_missing_fact";

export class HostRuntimeEnvelopeValidationError extends Error {
  readonly code: HostRuntimeEnvelopeValidationErrorCode;
  readonly endpointId?: string;
  readonly fieldName?: string;

  constructor(params: {
    code: HostRuntimeEnvelopeValidationErrorCode;
    message: string;
    endpointId?: string;
    fieldName?: string;
  }) {
    super(params.message);
    this.name = "HostRuntimeEnvelopeValidationError";
    this.code = params.code;
    this.endpointId = params.endpointId;
    this.fieldName = params.fieldName;
  }
}

export function buildHostRuntimePreparedFacts(params: {
  ownershipDecisions?: Record<string, TurnOwnerDecision>;
  envelopeSources?: Record<string, unknown>;
}): HostRuntimePreparedFactsBuild {
  const preparedFacts: Record<string, HostRuntimePreparedFacts> = {};
  const decisions = params.ownershipDecisions ?? {};
  const sources = params.envelopeSources ?? {};

  for (const [endpointId, decision] of Object.entries(decisions).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (decision.owner !== "external-host") {
      continue;
    }
    const envelope = readHostRuntimeEnvelope(sources[endpointId], decision);
    preparedFacts[endpointId] = {
      kind: "host-runtime-prepared-facts",
      version: 1,
      hostMode: "external-hosted",
      envelope,
    };
  }

  if (Object.keys(preparedFacts).length === 0) {
    return {};
  }

  const serialized = serializeHostRuntimePreparedFacts(preparedFacts);
  return {
    preparedFacts,
    fingerprint: fingerprintJson(serialized),
    serialized,
  };
}

export function serializeHostRuntimePreparedFacts(
  preparedFacts: Record<string, HostRuntimePreparedFacts>,
): JsonObject {
  const serialized: JsonObject = {};
  for (const [endpointId, facts] of Object.entries(preparedFacts).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    serialized[endpointId] = stabilizeJsonValue(facts as unknown as JsonValue);
  }
  return serialized;
}

export function readHostRuntimePreparedFactsRecord(
  value: unknown,
): Record<string, HostRuntimePreparedFacts> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const preparedFacts: Record<string, HostRuntimePreparedFacts> = {};
  for (const [endpointId, rawFacts] of Object.entries(value)) {
    const facts = readHostRuntimePreparedFacts(endpointId, rawFacts);
    if (!facts) {
      return undefined;
    }
    preparedFacts[endpointId] = facts;
  }
  return preparedFacts;
}

function readHostRuntimePreparedFacts(
  endpointId: string,
  value: unknown,
): HostRuntimePreparedFacts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.kind !== "host-runtime-prepared-facts" ||
    value.version !== 1 ||
    value.hostMode !== "external-hosted"
  ) {
    return undefined;
  }
  const decision: TurnOwnerDecision = {
    owner: "external-host",
    reason: "endpoint-owner",
    endpointId,
    auditId: "binding-readback",
  };
  try {
    return {
      kind: "host-runtime-prepared-facts",
      version: 1,
      hostMode: "external-hosted",
      envelope: readHostRuntimeEnvelope(value.envelope, decision, { skipAuditMatch: true }),
    };
  } catch {
    return undefined;
  }
}

function readHostRuntimeEnvelope(
  value: unknown,
  decision: TurnOwnerDecision,
  options: { skipAuditMatch?: boolean } = {},
): HostRuntimeEnvelope {
  if (!isRecord(value)) {
    throwMissingFact(decision.endpointId, "openclawRuntimeEnvelope");
  }
  const endpointId = decision.endpointId;
  const envelope = {
    kind: readLiteral(value.kind, "host-runtime-envelope", endpointId, "kind"),
    version: readLiteral(value.version, 1, endpointId, "version"),
    owner: readLiteral(value.owner, "external-host", endpointId, "owner"),
    hostId: readRequiredString(value.hostId, endpointId, "hostId"),
    requestId: readRequiredString(value.requestId, endpointId, "requestId"),
    auditId: readRequiredString(value.auditId, endpointId, "auditId"),
    endpoint: readEndpointFacts(value.endpoint, endpointId),
    conversation: readConversationFacts(value.conversation, endpointId),
    provider: readProviderFacts(value.provider, endpointId),
    auth: readAuthFacts(value.auth, endpointId),
    tools: readToolsFacts(value.tools, endpointId),
    delivery: readDeliveryFacts(value.delivery, endpointId),
    compaction: readCompactionFacts(value.compaction, endpointId),
  } satisfies HostRuntimeEnvelope;

  if (decision.hostId && envelope.hostId !== decision.hostId) {
    throwConflict(
      endpointId,
      "hostId",
      `Host runtime envelope hostId "${envelope.hostId}" does not match ownership hostId "${decision.hostId}".`,
    );
  }
  if (decision.threadOwnerId && envelope.conversation.threadOwner !== "external-host") {
    throwConflict(
      endpointId,
      "conversation.threadOwner",
      "Host runtime envelope must keep the conversation thread owner on host.",
    );
  }
  if (!options.skipAuditMatch && envelope.auditId !== decision.auditId) {
    throwConflict(
      endpointId,
      "auditId",
      `Host runtime envelope auditId "${envelope.auditId}" does not match ownership auditId "${decision.auditId}".`,
    );
  }
  if (envelope.endpoint.endpointId !== decision.endpointId) {
    throwConflict(
      endpointId,
      "endpoint.endpointId",
      `Host runtime envelope endpointId "${envelope.endpoint.endpointId}" does not match ownership endpointId "${decision.endpointId}".`,
    );
  }
  return envelope;
}

function readEndpointFacts(value: unknown, endpointId: string): HostRuntimeEnvelope["endpoint"] {
  const record = readRequiredRecord(value, endpointId, "endpoint");
  return cleanObject({
    channel: readRequiredString(record.channel, endpointId, "endpoint.channel"),
    accountId: readOptionalString(record.accountId, endpointId, "endpoint.accountId"),
    endpointId: readRequiredString(record.endpointId, endpointId, "endpoint.endpointId"),
    externalIdentity: readRequiredString(
      record.externalIdentity,
      endpointId,
      "endpoint.externalIdentity",
    ),
  });
}

function readConversationFacts(
  value: unknown,
  endpointId: string,
): HostRuntimeEnvelope["conversation"] {
  const record = readRequiredRecord(value, endpointId, "conversation");
  return cleanObject({
    sessionKey: readRequiredString(record.sessionKey, endpointId, "conversation.sessionKey"),
    threadId: readOptionalString(record.threadId, endpointId, "conversation.threadId"),
    threadOwner: readLiteral(
      record.threadOwner,
      "external-host",
      endpointId,
      "conversation.threadOwner",
    ),
  });
}

function readProviderFacts(value: unknown, endpointId: string): HostRuntimeEnvelope["provider"] {
  const record = readRequiredRecord(value, endpointId, "provider");
  return cleanObject({
    modelRef: readRequiredString(record.modelRef, endpointId, "provider.modelRef"),
    routingPolicyId: readRequiredString(
      record.routingPolicyId,
      endpointId,
      "provider.routingPolicyId",
    ),
    fallbackPolicyId: readOptionalString(
      record.fallbackPolicyId,
      endpointId,
      "provider.fallbackPolicyId",
    ),
    cooldownPolicyId: readOptionalString(
      record.cooldownPolicyId,
      endpointId,
      "provider.cooldownPolicyId",
    ),
  });
}

function readAuthFacts(value: unknown, endpointId: string): HostRuntimeEnvelope["auth"] {
  const record = readRequiredRecord(value, endpointId, "auth");
  rejectRawCredentialMaterial(record, endpointId);
  return {
    credentialRef: readRequiredString(record.credentialRef, endpointId, "auth.credentialRef"),
    eligibility: readEnum(
      record.eligibility,
      ["ok", "expired", "missing", "unresolved"],
      endpointId,
      "auth.eligibility",
    ),
  };
}

function readToolsFacts(value: unknown, endpointId: string): HostRuntimeEnvelope["tools"] {
  const record = readRequiredRecord(value, endpointId, "tools");
  return {
    capabilityPlanId: readRequiredString(
      record.capabilityPlanId,
      endpointId,
      "tools.capabilityPlanId",
    ),
    allowedToolIds: readStringArray(record.allowedToolIds, endpointId, "tools.allowedToolIds"),
    policy: readLiteral(record.policy, "host-authorized", endpointId, "tools.policy"),
  };
}

function readDeliveryFacts(value: unknown, endpointId: string): HostRuntimeEnvelope["delivery"] {
  const record = readRequiredRecord(value, endpointId, "delivery");
  return cleanObject({
    policyId: readRequiredString(record.policyId, endpointId, "delivery.policyId"),
    accountId: readOptionalString(record.accountId, endpointId, "delivery.accountId"),
    outboundTarget: readRequiredString(
      record.outboundTarget,
      endpointId,
      "delivery.outboundTarget",
    ),
    confirmationPolicy: readOptionalString(
      record.confirmationPolicy,
      endpointId,
      "delivery.confirmationPolicy",
    ),
  });
}

function readCompactionFacts(
  value: unknown,
  endpointId: string,
): HostRuntimeEnvelope["compaction"] {
  const record = readRequiredRecord(value, endpointId, "compaction");
  return cleanObject({
    owner: readEnum(
      record.owner,
      ["openclaw", "external-host", "provider", "disabled"],
      endpointId,
      "compaction.owner",
    ),
    hostCompactionId: readOptionalString(
      record.hostCompactionId,
      endpointId,
      "compaction.hostCompactionId",
    ),
  });
}

function rejectRawCredentialMaterial(record: Record<string, unknown>, endpointId: string): void {
  for (const fieldName of ["credentialValue", "apiKey", "accessToken", "refreshToken", "secret"]) {
    if (fieldName in record) {
      throwInvalidFact(endpointId, `auth.${fieldName}`);
    }
  }
}

function readRequiredRecord(
  value: unknown,
  endpointId: string,
  fieldName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throwMissingFact(endpointId, fieldName);
  }
  return value;
}

function readRequiredString(value: unknown, endpointId: string, fieldName: string): string {
  const result = readOptionalString(value, endpointId, fieldName);
  if (result) {
    return result;
  }
  throwMissingFact(endpointId, fieldName);
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
  throwInvalidFact(endpointId, fieldName);
}

function readStringArray(value: unknown, endpointId: string, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throwMissingFact(endpointId, fieldName);
  }
  return value.map((entry) => readRequiredString(entry, endpointId, fieldName));
}

function readLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  endpointId: string,
  fieldName: string,
): T {
  if (value === undefined) {
    throwMissingFact(endpointId, fieldName);
  }
  if (value !== expected) {
    throwInvalidFact(endpointId, fieldName);
  }
  return expected;
}

function readEnum<T extends string>(
  value: unknown,
  options: readonly T[],
  endpointId: string,
  fieldName: string,
): T {
  if (value === undefined) {
    throwMissingFact(endpointId, fieldName);
  }
  if (typeof value !== "string" || !options.includes(value as T)) {
    throwInvalidFact(endpointId, fieldName);
  }
  return value as T;
}

function throwMissingFact(endpointId: string, fieldName: string): never {
  throw new HostRuntimeEnvelopeValidationError({
    code: "openclaw_host_runtime_missing_fact",
    endpointId,
    fieldName,
    message: `Externally hosted OpenClaw endpoint "${endpointId}" is missing required runtime fact "${fieldName}".`,
  });
}

function throwInvalidFact(endpointId: string, fieldName: string): never {
  throw new HostRuntimeEnvelopeValidationError({
    code: "openclaw_host_runtime_invalid",
    endpointId,
    fieldName,
    message: `Externally hosted OpenClaw endpoint "${endpointId}" has invalid runtime fact "${fieldName}".`,
  });
}

function throwConflict(endpointId: string, fieldName: string, message: string): never {
  throw new HostRuntimeEnvelopeValidationError({
    code: "openclaw_host_runtime_conflict",
    endpointId,
    fieldName,
    message,
  });
}

function cleanObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fingerprintJson(value: JsonValue): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stabilizeJsonValue(value)))
    .digest("hex");
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
