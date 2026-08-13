/* oxlint-disable max-lines -- Record/epoch, one-shot scope, and carrier state share one private owner. */
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { ResolvedChannelMessageIngress } from "./runtime-types.js";

export type ChannelAdmissionEvidence = Readonly<{
  kind: "channel-admission-evidence";
}>;

type ChannelAdmissionContribution = Readonly<{
  participant:
    | { state: "present"; rawPrincipalRef: string }
    | { state: "unknown" }
    | { state: "unsupported" };
  decision?: Readonly<{
    participantAware: boolean;
    outcomeAffecting: boolean;
  }>;
}>;

type ChannelAdmissionEvidencePayload =
  | Readonly<{
      kind: "leaf";
      createdAt: number;
      generation: number;
      contribution: ChannelAdmissionContribution;
    }>
  | Readonly<{
      kind: "aggregate";
      createdAt: number;
      generation: number;
      sources: readonly (ChannelAdmissionEvidence | undefined)[];
    }>;

type ConsumedChannelAdmissionEvidence = Readonly<{
  ingressState: "present" | "unknown" | "unsupported";
  invoker: { state: "present"; kind: "person"; rawPrincipalRef: string } | { state: "unknown" };
  assuranceRef?: string;
  decisionCoverage?: "enforced" | "attribution-only" | "unknown" | "unsupported";
}>;

type ChannelIngressResolutionBinding = Readonly<{
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  owner?: ChannelAdmissionEvidenceOwner;
  ownerEpoch?: object;
  scope?: ChannelIngressResolutionScope;
  publicScopeKey?: string;
  handoff: { consumed: boolean };
}>;

type ChannelAdmissionEvidenceOwner = Readonly<{
  channelId: string;
  record: object;
  epoch: object;
  isLive: () => boolean;
}>;

type PreparedChannelAdmissionEvidence = Readonly<{
  kind: "prepared-channel-admission-evidence";
}>;

const CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS = 16;
const CHANNEL_ADMISSION_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CHANNEL_ADMISSION_EVIDENCE_STATE_KEY = Symbol.for("openclaw.channelAdmissionEvidenceState");
const state = resolveGlobalSingleton(CHANNEL_ADMISSION_EVIDENCE_STATE_KEY, () => ({
  collectionEnabled: false,
  generation: 0,
  payloadByEvidence: new WeakMap<object, ChannelAdmissionEvidencePayload>(),
  resolutionByIngress: new WeakMap<object, ChannelIngressResolutionBinding>(),
  ownerByChannelId: new Map<string, ChannelAdmissionEvidenceOwner>(),
  evidenceByPreparation: new WeakMap<object, ChannelAdmissionEvidence | undefined>(),
  evidenceByContext: new WeakMap<object, ChannelAdmissionEvidence>(),
  scopeByContext: new WeakMap<object, string>(),
  consumedEvidence: new WeakSet<object>(),
  decisionSink: undefined as ((receipt: DecisionReceiptV1) => boolean) | undefined,
}));

/** Register one exact native channel record as the current in-process producer. */
export function registerChannelAdmissionEvidenceOwner(
  owner: ChannelAdmissionEvidenceOwner,
): () => void {
  state.ownerByChannelId.set(owner.channelId, owner);
  return () => {
    if (state.ownerByChannelId.get(owner.channelId) === owner) {
      state.ownerByChannelId.delete(owner.channelId);
    }
  };
}

export function configureChannelAdmissionEvidenceCollection(enabled: boolean): () => void {
  const generation = ++state.generation;
  state.collectionEnabled = enabled;
  return () => {
    if (state.generation === generation) {
      state.collectionEnabled = false;
      state.generation += 1;
    }
  };
}

export function configureChannelAdmissionDecisionSink(
  sink: (receipt: DecisionReceiptV1) => boolean,
): () => void {
  state.decisionSink = sink;
  return () => {
    if (state.decisionSink === sink) {
      state.decisionSink = undefined;
    }
  };
}

function mintChannelAdmissionEvidence(
  payload:
    | Omit<Extract<ChannelAdmissionEvidencePayload, { kind: "leaf" }>, "createdAt" | "generation">
    | Omit<
        Extract<ChannelAdmissionEvidencePayload, { kind: "aggregate" }>,
        "createdAt" | "generation"
      >,
): ChannelAdmissionEvidence | undefined {
  if (!state.collectionEnabled) {
    return undefined;
  }
  const evidence = Object.freeze({ kind: "channel-admission-evidence" as const });
  state.payloadByEvidence.set(
    evidence,
    Object.freeze({ ...payload, createdAt: Date.now(), generation: state.generation }),
  );
  return evidence;
}

function scopedParticipantRef(params: {
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
}): string | undefined {
  const channelId = params.channelId;
  const accountId = params.accountId || "default";
  const rawPrincipalRef = params.rawPrincipalRef == null ? "" : String(params.rawPrincipalRef);
  if (!channelId || !rawPrincipalRef) {
    return undefined;
  }
  // Preserve tuple boundaries: channel, account, and participant identifiers may
  // themselves contain colons or other separators.
  const scoped = JSON.stringify([channelId, accountId, rawPrincipalRef]);
  return scoped.length <= 4_096 ? scoped : undefined;
}

function participantContribution(params: {
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
}): ChannelAdmissionContribution {
  const rawPrincipalRef = scopedParticipantRef(params);
  return Object.freeze(
    rawPrincipalRef
      ? { participant: Object.freeze({ state: "present" as const, rawPrincipalRef }) }
      : { participant: Object.freeze({ state: "unknown" as const }) },
  );
}

type ChannelIngressResolutionScope = {
  conversation: {
    kind: "direct" | "group" | "channel";
    id: string;
    parentId?: string;
    threadId?: string;
  };
};

const MAX_CHANNEL_ADMISSION_SCOPE_BYTES = 32_768;
const MAX_CHANNEL_ADMISSION_SCOPE_NODES = 256;
const INVALID_SCOPE_VALUE = Symbol("invalid-channel-admission-scope-value");

function snapshotOwnedData(
  value: unknown,
  budget = { nodes: 0 },
  depth = 0,
): unknown | typeof INVALID_SCOPE_VALUE {
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

function publicResultScopeKey(result: ResolvedChannelMessageIngress): string | undefined {
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

/** Brand an exact resolver object with its non-authoritative input binding. */
export function recordChannelIngressResolution(params: {
  result: ResolvedChannelMessageIngress;
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  scope: ChannelIngressResolutionScope;
}): ResolvedChannelMessageIngress {
  const owner = state.ownerByChannelId.get(params.channelId);
  const activeOwner = owner?.isLive() === true ? owner : undefined;
  state.resolutionByIngress.set(
    params.result,
    Object.freeze({
      channelId: params.channelId,
      accountId: params.accountId,
      rawPrincipalRef: params.rawPrincipalRef,
      participantOutcomeAffecting: params.participantOutcomeAffecting,
      owner: activeOwner,
      ownerEpoch: activeOwner?.epoch,
      scope: Object.freeze(params.scope),
      publicScopeKey: publicResultScopeKey(params.result),
      handoff: { consumed: false },
    }),
  );
  return params.result;
}

function ownDataValue(value: object, key: PropertyKey): unknown | typeof INVALID_SCOPE_VALUE {
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

function normalizeScopeId(value: unknown): string | undefined | typeof INVALID_SCOPE_VALUE {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : INVALID_SCOPE_VALUE;
}

function contextHandoffMatches(params: {
  binding: ChannelIngressResolutionBinding;
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  contextParams: object;
}): boolean {
  const conversation = ownDataValue(params.contextParams, "conversation");
  const route = ownDataValue(params.contextParams, "route");
  const reply = ownDataValue(params.contextParams, "reply");
  if (
    !conversation ||
    typeof conversation !== "object" ||
    !route ||
    typeof route !== "object" ||
    !reply ||
    typeof reply !== "object"
  ) {
    return false;
  }
  const expected = params.binding.scope?.conversation;
  if (!expected) {
    return false;
  }
  const routeAccountId = ownDataValue(route, "accountId");
  const effectiveAccountId =
    routeAccountId === undefined ? params.accountId : normalizeScopeId(routeAccountId);
  const conversationKind = ownDataValue(conversation, "kind");
  const conversationId = normalizeScopeId(ownDataValue(conversation, "id"));
  const conversationParentId = normalizeScopeId(ownDataValue(conversation, "parentId"));
  const conversationThreadId = normalizeScopeId(ownDataValue(conversation, "threadId"));
  const replyThreadId = normalizeScopeId(ownDataValue(reply, "messageThreadId"));
  const replyParentId = normalizeScopeId(ownDataValue(reply, "threadParentId"));
  const nativeConversationId = normalizeScopeId(ownDataValue(conversation, "nativeChannelId"));
  const nativeReplyId = normalizeScopeId(ownDataValue(reply, "nativeChannelId"));
  const values = [
    effectiveAccountId,
    conversationId,
    conversationParentId,
    conversationThreadId,
    replyThreadId,
    replyParentId,
    nativeConversationId,
    nativeReplyId,
  ];
  if (values.includes(INVALID_SCOPE_VALUE)) {
    return false;
  }
  const nativeId = nativeReplyId ?? nativeConversationId;
  if (
    typeof nativeId === "string" &&
    ![expected.id, expected.parentId, expected.threadId].includes(nativeId)
  ) {
    return false;
  }
  if (
    (replyThreadId !== undefined &&
      conversationThreadId !== undefined &&
      replyThreadId !== conversationThreadId) ||
    (replyParentId !== undefined &&
      conversationParentId !== undefined &&
      replyParentId !== conversationParentId) ||
    (nativeReplyId !== undefined &&
      nativeConversationId !== undefined &&
      nativeReplyId !== nativeConversationId)
  ) {
    return false;
  }
  return (
    scopedParticipantRef(params.binding) ===
      scopedParticipantRef({
        channelId: params.channelId,
        accountId: effectiveAccountId as string | undefined,
        rawPrincipalRef: params.rawPrincipalRef,
      }) &&
    conversationKind === expected.kind &&
    conversationId === expected.id &&
    (replyParentId ?? conversationParentId) === expected.parentId &&
    (replyThreadId ?? conversationThreadId) === expected.threadId
  );
}

function unknownChannelAdmissionEvidence(): ChannelAdmissionEvidence | undefined {
  return mintChannelAdmissionEvidence({
    kind: "leaf",
    contribution: Object.freeze({ participant: { state: "unknown" as const } }),
  });
}

/** Consume and validate the exact resolver-to-context handoff before context construction. */
export function prepareHostChannelContextAdmissionEvidence(params: {
  owner?: ChannelAdmissionEvidenceOwner;
  channelId: string;
  accountId?: string;
  ingress?:
    | ResolvedChannelMessageIngress
    | readonly ResolvedChannelMessageIngress[]
    | "unsupported";
  rawPrincipalRef: string | number | null | undefined;
  contextParams: object;
}): PreparedChannelAdmissionEvidence {
  const preparation = Object.freeze({ kind: "prepared-channel-admission-evidence" as const });
  if (params.ingress === "unsupported") {
    state.evidenceByPreparation.set(
      preparation,
      mintChannelAdmissionEvidence({
        kind: "leaf",
        contribution: Object.freeze({ participant: { state: "unsupported" as const } }),
      }),
    );
    return preparation;
  }
  const results =
    params.ingress === undefined
      ? []
      : Array.isArray(params.ingress)
        ? params.ingress
        : [params.ingress as ResolvedChannelMessageIngress];
  const seen = new Set<object>();
  const validBindings: ChannelIngressResolutionBinding[] = [];
  let valid = results.length > 0 && results.length <= CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS;
  for (const result of results) {
    const binding = state.resolutionByIngress.get(result);
    const firstUse = binding !== undefined && !binding.handoff.consumed && !seen.has(result);
    if (binding && !binding.handoff.consumed) {
      // Consume before validation and before the ordinary context builder runs.
      binding.handoff.consumed = true;
    }
    seen.add(result);
    const ownerMatches =
      params.owner !== undefined &&
      binding?.owner === params.owner &&
      binding.ownerEpoch === params.owner.epoch &&
      state.ownerByChannelId.get(params.channelId) === params.owner &&
      params.owner.isLive();
    const resultIngress = ownDataValue(result, "ingress");
    const resultMatches =
      binding?.publicScopeKey !== undefined &&
      publicResultScopeKey(result) === binding.publicScopeKey &&
      resultIngress !== null &&
      typeof resultIngress === "object" &&
      ownDataValue(resultIngress, "admission") === "dispatch";
    const contextMatches = binding !== undefined && contextHandoffMatches({ ...params, binding });
    if (!firstUse || !ownerMatches || !resultMatches || !contextMatches || !binding) {
      valid = false;
    } else {
      validBindings.push(binding);
    }
  }
  const sources = valid
    ? validBindings.map((binding) => {
        const contribution = participantContribution(binding);
        return mintChannelAdmissionEvidence({
          kind: "leaf",
          contribution: Object.freeze({
            ...contribution,
            decision: Object.freeze({
              participantAware: contribution.participant.state === "present",
              outcomeAffecting: binding.participantOutcomeAffecting,
            }),
          }),
        });
      })
    : [];
  state.evidenceByPreparation.set(
    preparation,
    valid ? combineChannelAdmissionEvidence(sources) : unknownChannelAdmissionEvidence(),
  );
  return preparation;
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

function finalizedContextScopeKey(context: object): string | undefined {
  const entries: unknown[] = [];
  for (const key of FINALIZED_CONTEXT_SCOPE_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(context, key);
    } catch {
      return undefined;
    }
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

/** Attach one prepared private carrier to the exact finalized context scope. */
export function bindHostChannelContextAdmissionEvidence(params: {
  context: object;
  preparation: PreparedChannelAdmissionEvidence;
}): void {
  const preparedEvidence = state.evidenceByPreparation.get(params.preparation);
  state.evidenceByPreparation.delete(params.preparation);
  if (!state.collectionEnabled) {
    return;
  }
  const scopeKey = finalizedContextScopeKey(params.context);
  const evidence =
    preparedEvidence && scopeKey !== undefined
      ? preparedEvidence
      : unknownChannelAdmissionEvidence();
  if (evidence) {
    state.evidenceByContext.set(params.context, evidence);
    if (scopeKey !== undefined) {
      state.scopeByContext.set(params.context, scopeKey);
    }
  }
}

export function readChannelContextAdmissionEvidence(
  context: object,
): ChannelAdmissionEvidence | undefined {
  return state.evidenceByContext.get(context);
}

/** Preserve private evidence when an owner intentionally replaces a finalized context object. */
export function copyChannelParticipantAdmissionEvidence(source: object, target: object): void {
  const evidence = state.evidenceByContext.get(source);
  if (!evidence) {
    return;
  }
  const sourceScope = state.scopeByContext.get(source);
  const targetScope = finalizedContextScopeKey(target);
  const safeEvidence =
    sourceScope !== undefined &&
    targetScope === sourceScope &&
    activePayload(evidence, Date.now()) !== undefined
      ? evidence
      : unknownChannelAdmissionEvidence();
  if (safeEvidence) {
    state.evidenceByContext.set(target, safeEvidence);
    if (targetScope !== undefined) {
      state.scopeByContext.set(target, targetScope);
    }
  }
}

function activePayload(
  evidence: ChannelAdmissionEvidence | undefined,
  now: number,
): ChannelAdmissionEvidencePayload | undefined {
  if (!evidence || state.consumedEvidence.has(evidence)) {
    return undefined;
  }
  const payload = state.payloadByEvidence.get(evidence);
  return payload &&
    payload.generation === state.generation &&
    now - payload.createdAt <= CHANNEL_ADMISSION_EVIDENCE_MAX_AGE_MS
    ? payload
    : undefined;
}

/** Preserve one source exactly; collected sources get one new bounded opaque aggregate. */
export function combineChannelAdmissionEvidence(
  evidence: readonly (ChannelAdmissionEvidence | undefined)[],
): ChannelAdmissionEvidence | undefined {
  if (!state.collectionEnabled) {
    return undefined;
  }
  if (evidence.length === 1) {
    return evidence[0];
  }
  if (evidence.length > CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS) {
    return mintChannelAdmissionEvidence({
      kind: "leaf",
      contribution: Object.freeze({ participant: { state: "unknown" } }),
    });
  }
  return mintChannelAdmissionEvidence({ kind: "aggregate", sources: Object.freeze([...evidence]) });
}

function inspectContributions(params: {
  evidence: ChannelAdmissionEvidence | undefined;
  now: number;
  seen: Set<object>;
}): ChannelAdmissionContribution[] {
  const payload = activePayload(params.evidence, params.now);
  if (!payload || !params.evidence || params.seen.has(params.evidence)) {
    return [{ participant: { state: "unknown" } }];
  }
  params.seen.add(params.evidence);
  return payload.kind === "leaf"
    ? [payload.contribution]
    : payload.sources.flatMap((source) => inspectContributions({ ...params, evidence: source }));
}

/** Compare opaque participants without exposing or consuming their raw references. */
export function compareChannelAdmissionParticipants(
  evidence: readonly (ChannelAdmissionEvidence | undefined)[],
): "same" | "mixed-or-unknown" {
  const contributions = evidence.flatMap((candidate) =>
    inspectContributions({ evidence: candidate, now: Date.now(), seen: new Set() }),
  );
  if (
    contributions.length === 0 ||
    contributions.length > CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS
  ) {
    return "mixed-or-unknown";
  }
  const participants = contributions.map((item) => item.participant);
  const first = participants[0];
  return first?.state === "present" &&
    participants.every(
      (item) => item.state === "present" && item.rawPrincipalRef === first.rawPrincipalRef,
    )
    ? "same"
    : "mixed-or-unknown";
}

function consumeContributions(params: {
  evidence: ChannelAdmissionEvidence | undefined;
  now: number;
  seen: Set<object>;
}): ChannelAdmissionContribution[] {
  const payload = activePayload(params.evidence, params.now);
  if (!payload || !params.evidence || params.seen.has(params.evidence)) {
    return [{ participant: { state: "unknown" } }];
  }
  params.seen.add(params.evidence);
  state.consumedEvidence.add(params.evidence);
  if (payload.kind === "leaf") {
    return [payload.contribution];
  }
  const contributions = payload.sources.flatMap((source) =>
    consumeContributions({ ...params, evidence: source }),
  );
  return contributions.length <= CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS
    ? contributions
    : [{ participant: { state: "unknown" } }];
}

function freezeConsumed(
  value: Omit<ConsumedChannelAdmissionEvidence, "invoker"> & {
    invoker: ConsumedChannelAdmissionEvidence["invoker"];
  },
): ConsumedChannelAdmissionEvidence {
  return Object.freeze({
    ...value,
    invoker: Object.freeze(value.invoker),
  });
}

/** Consume one aggregate at run admission. Missing, forged, stale, or reused carriers are unknown. */
export function consumeChannelAdmissionEvidence(
  evidence: ChannelAdmissionEvidence | undefined,
): ConsumedChannelAdmissionEvidence {
  const contributions = consumeContributions({ evidence, now: Date.now(), seen: new Set() });
  const participants = contributions.map((item) => item.participant);
  const allUnsupported =
    participants.length > 0 && participants.every((item) => item.state === "unsupported");
  if (allUnsupported) {
    return freezeConsumed({
      ingressState: "unsupported",
      invoker: { state: "unknown" },
      decisionCoverage: "unsupported",
    });
  }

  const present = participants.filter(
    (item): item is Extract<(typeof participants)[number], { state: "present" }> =>
      item.state === "present",
  );
  const sameParticipant =
    present.length === participants.length &&
    present.every((item) => item.rawPrincipalRef === present[0]?.rawPrincipalRef);
  if (!sameParticipant || !present[0]) {
    return freezeConsumed({
      ingressState: "unknown",
      invoker: { state: "unknown" },
      decisionCoverage: "unknown",
    });
  }

  const everyDecisionEnforced = contributions.every(
    (item) => item.decision?.participantAware && item.decision.outcomeAffecting,
  );
  return freezeConsumed({
    ingressState: "present",
    invoker: {
      state: "present",
      kind: "person",
      rawPrincipalRef: present[0].rawPrincipalRef,
    },
    assuranceRef: "channel-admission",
    decisionCoverage: everyDecisionEnforced ? "enforced" : "attribution-only",
  });
}

/** Queue the channel decision after its exact identity tuple on the shared audit FIFO. */
export function recordChannelAdmissionDecision(params: {
  contextId: string;
  executionId: string;
  runId: string;
  occurredAt: number;
  coverageState: NonNullable<ConsumedChannelAdmissionEvidence["decisionCoverage"]>;
}): boolean {
  const missingEvidence =
    params.coverageState === "unknown"
      ? ["channel.admission_evidence"]
      : params.coverageState === "unsupported"
        ? ["channel.adapter_identity"]
        : params.coverageState === "attribution-only"
          ? ["decision.participant_effect"]
          : [];
  return (
    state.decisionSink?.({
      schemaVersion: 1,
      receiptId: `${params.contextId}:channel-admission`,
      contextId: params.contextId,
      executionId: params.executionId,
      runId: params.runId,
      occurredAt: params.occurredAt,
      action: {
        family: "channel",
        operation: "admission",
        summary: "Channel ingress admitted this agent execution.",
      },
      decision: {
        outcome:
          params.coverageState === "unknown" || params.coverageState === "unsupported"
            ? "unknown"
            : "allowed",
        reasonCode:
          params.coverageState === "enforced"
            ? "channel_ingress_participant_enforced"
            : params.coverageState === "attribution-only"
              ? "channel_ingress_attribution_only"
              : params.coverageState === "unsupported"
                ? "channel_ingress_identity_unsupported"
                : "channel_ingress_identity_unknown",
      },
      enforcement: {
        coverageState: params.coverageState,
        evaluatorRef: "channel-ingress",
        policyRefs: [],
        grantRefs: [],
        contextFieldsUsed: params.coverageState === "enforced" ? ["invoker.principal"] : [],
      },
      source: {
        owner: "channel-ingress",
        recordRef: `${params.contextId}:channel-admission`,
        decisionBoundary: "channel-ingress.run-admission",
      },
      missingEvidence,
      remediation:
        params.coverageState === "enforced"
          ? []
          : [
              {
                code: "treat_as_diagnostic_provenance",
                text: "Treat this receipt as diagnostic provenance, not authorization.",
              },
            ],
    }) ?? false
  );
}
