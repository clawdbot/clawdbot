import type { ResolvedChannelMessageIngress } from "./runtime-types.js";

// Private accessor-free snapshots for channel admission handoff scope keys.
const MAX_CHANNEL_ADMISSION_SCOPE_BYTES = 32_768;
const MAX_CHANNEL_ADMISSION_SCOPE_NODES = 256;
export const INVALID_SCOPE_VALUE = Symbol("invalid-channel-admission-scope-value");

function snapshotOwnedData(value: unknown, budget = { nodes: 0 }, depth = 0): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_CHANNEL_ADMISSION_SCOPE_NODES || depth > 6) {
    return INVALID_SCOPE_VALUE;
  }
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_SCOPE_VALUE;
  }
  if (typeof value !== "object") {
    return INVALID_SCOPE_VALUE;
  }
  let descriptors: ReturnType<typeof Object.getOwnPropertyDescriptors>;
  let symbols: symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return INVALID_SCOPE_VALUE;
  }
  if (symbols.some((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
    return INVALID_SCOPE_VALUE;
  }
  const keys = Object.keys(descriptors)
    .filter((key) => descriptors[key]?.enumerable)
    .toSorted();
  const entries: unknown[] = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return INVALID_SCOPE_VALUE;
    }
    const captured = snapshotOwnedData(descriptor.value, budget, depth + 1);
    if (captured === INVALID_SCOPE_VALUE) {
      return INVALID_SCOPE_VALUE;
    }
    entries.push([key, captured]);
  }
  return Array.isArray(value) ? ["array", entries] : ["record", entries];
}

function stableOwnedScopeKey(value: unknown): string | undefined {
  const snapshot = snapshotOwnedData(value);
  if (snapshot === INVALID_SCOPE_VALUE) {
    return undefined;
  }
  try {
    const key = JSON.stringify(snapshot);
    return key.length <= MAX_CHANNEL_ADMISSION_SCOPE_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

function safeOwnPropertyDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

export function ownDataValue(value: object, key: PropertyKey): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return INVALID_SCOPE_VALUE;
  }
  if (!descriptor) {
    return undefined;
  }
  return "value" in descriptor ? descriptor.value : INVALID_SCOPE_VALUE;
}

export function publicResultScopeKey(result: ResolvedChannelMessageIngress): string | undefined {
  const stateValue = ownDataValue(result, "state");
  if (!stateValue || typeof stateValue !== "object") {
    return undefined;
  }
  const routeFacts = ownDataValue(stateValue, "routeFacts");
  if (!Array.isArray(routeFacts)) {
    return undefined;
  }
  const routeCount = ownDataValue(routeFacts, "length");
  if (typeof routeCount !== "number" || routeCount > MAX_CHANNEL_ADMISSION_SCOPE_NODES) {
    return undefined;
  }
  const routes: unknown[] = [];
  for (let index = 0; index < routeCount; index += 1) {
    const descriptor = safeOwnPropertyDescriptor(routeFacts, String(index));
    const route = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (!route || typeof route !== "object") {
      return undefined;
    }
    routes.push({
      id: ownDataValue(route, "id"),
      kind: ownDataValue(route, "kind"),
      gate: ownDataValue(route, "gate"),
      effect: ownDataValue(route, "effect"),
      precedence: ownDataValue(route, "precedence"),
      senderPolicy: ownDataValue(route, "senderPolicy"),
    });
  }
  return stableOwnedScopeKey({
    accountId: ownDataValue(stateValue, "accountId"),
    channelId: ownDataValue(stateValue, "channelId"),
    conversationKind: ownDataValue(stateValue, "conversationKind"),
    event: ownDataValue(stateValue, "event"),
    routeFacts: routes,
  });
}

const FINALIZED_CONTEXT_SCOPE_FIELDS = [
  "OriginatingChannel",
  "AccountId",
  "SenderId",
  "ChatType",
  "ChatId",
  "SessionKey",
  "AgentId",
  "DmScope",
  "ParentSessionKey",
  "ModelParentSessionKey",
  "MessageSid",
  "MessageSidFull",
  "ReplyToId",
  "ReplyToIdFull",
  "To",
  "From",
  "OriginatingTo",
  "MessageThreadId",
  "NativeChannelId",
  "ThreadParentId",
  "InboundEventKind",
  "Provider",
  "Surface",
  "NativeDirectUserId",
] as const;

export function finalizedContextScopeKey(context: object): string | undefined {
  const entries: unknown[] = [];
  for (const key of FINALIZED_CONTEXT_SCOPE_FIELDS) {
    const descriptor = safeOwnPropertyDescriptor(context, key);
    if (!descriptor) {
      entries.push([key, "absent"]);
      continue;
    }
    if (!("value" in descriptor)) {
      return undefined;
    }
    const value = descriptor.value;
    if (
      value !== undefined &&
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return undefined;
    }
    entries.push([key, "present", value]);
  }
  return stableOwnedScopeKey(entries);
}
