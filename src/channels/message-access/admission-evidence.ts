import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  createChannelAdmissionDecisionReceipt,
  type ChannelAdmissionDecisionReceiptInput,
} from "./admission-decision-receipt.js";
import {
  finalizedContextScopeKey,
  INVALID_SCOPE_VALUE,
  ownDataValue,
  publicResultScopeKey,
} from "./admission-evidence-scope-key.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";

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
    identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
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
  identifierAuthentication?: "affected" | "evaluated" | "not-evaluated" | "unknown";
}>;

type ChannelIngressResolutionBinding = Readonly<{
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
  owner?: ChannelAdmissionEvidenceOwner;
  ownerEpoch?: object;
  scope?: ChannelIngressResolutionScope;
  contextBinding?: Readonly<ChannelIngressContextBinding>;
  publicScopeKey?: string;
  handoff: { consumed: boolean };
}>;

type ChannelAdmissionEvidenceOwner = Readonly<{
  channelId: string;
  record: object;
  epoch: object;
  isLive: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
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
  gatewayResolverByPreparation: new WeakMap<object, GatewayContextResolver>(),
  evidenceByContext: new WeakMap<object, ChannelAdmissionEvidence>(),
  gatewayResolverByContext: new WeakMap<object, GatewayContextResolver>(),
  gatewayResolverConflictsByContext: new WeakSet<object>(),
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
  contextBinding?: ChannelIngressContextBinding;
};

/** Brand an exact resolver object with its non-authoritative input binding. */
function snapshotContextBinding(
  value: unknown,
): Readonly<ChannelIngressContextBinding> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const agentId = ownDataValue(value, "agentId");
  const sessionKey = ownDataValue(value, "sessionKey");
  const messageId = ownDataValue(value, "messageId");
  const nativeChannelId = ownDataValue(value, "nativeChannelId");
  const inboundEventKind = ownDataValue(value, "inboundEventKind");
  if (
    typeof agentId !== "string" ||
    typeof sessionKey !== "string" ||
    (messageId !== undefined && typeof messageId !== "string") ||
    (nativeChannelId !== undefined && typeof nativeChannelId !== "string") ||
    (inboundEventKind !== "user_request" && inboundEventKind !== "room_event")
  ) {
    return undefined;
  }
  return Object.freeze({ agentId, sessionKey, messageId, nativeChannelId, inboundEventKind });
}

export function recordChannelIngressResolution(params: {
  result: ResolvedChannelMessageIngress;
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
  identifierAuthentication: "affected" | "evaluated" | "not-evaluated";
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
      identifierAuthentication: params.identifierAuthentication,
      owner: activeOwner,
      ownerEpoch: activeOwner?.epoch,
      scope: Object.freeze({ conversation: Object.freeze({ ...params.scope.conversation }) }),
      contextBinding: snapshotContextBinding(params.scope.contextBinding),
      publicScopeKey: publicResultScopeKey(params.result),
      handoff: { consumed: false },
    }),
  );
  return params.result;
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
  const message = ownDataValue(params.contextParams, "message");
  if (
    !conversation ||
    typeof conversation !== "object" ||
    !route ||
    typeof route !== "object" ||
    !reply ||
    typeof reply !== "object" ||
    !message ||
    typeof message !== "object"
  ) {
    return false;
  }
  const expected = params.binding.scope?.conversation;
  const expectedContext = params.binding.contextBinding;
  if (!expected || !expectedContext) {
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
  const routeAgentId = normalizeScopeId(ownDataValue(route, "agentId"));
  const dispatchSessionKey = normalizeScopeId(ownDataValue(route, "dispatchSessionKey"));
  const routeSessionKey = normalizeScopeId(ownDataValue(route, "routeSessionKey"));
  const inboundEventKindValue = ownDataValue(message, "inboundEventKind");
  const inboundEventKind =
    inboundEventKindValue === undefined || inboundEventKindValue === null
      ? "user_request"
      : normalizeScopeId(inboundEventKindValue);
  const values = [
    effectiveAccountId,
    conversationId,
    conversationParentId,
    conversationThreadId,
    replyThreadId,
    replyParentId,
    nativeConversationId,
    nativeReplyId,
    routeAgentId,
    dispatchSessionKey,
    routeSessionKey,
    inboundEventKind,
  ];
  if (values.includes(INVALID_SCOPE_VALUE)) {
    return false;
  }
  const nativeId = nativeReplyId ?? nativeConversationId;
  if (
    (expectedContext.nativeChannelId !== undefined &&
      nativeId !== expectedContext.nativeChannelId) ||
    (expectedContext.nativeChannelId === undefined &&
      typeof nativeId === "string" &&
      ![expected.id, expected.parentId, expected.threadId].includes(nativeId))
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
    (replyThreadId ?? conversationThreadId) === expected.threadId &&
    routeAgentId === expectedContext.agentId &&
    (dispatchSessionKey ?? routeSessionKey) === expectedContext.sessionKey &&
    inboundEventKind === expectedContext.inboundEventKind
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
  const contextMessageId = normalizeScopeId(ownDataValue(params.contextParams, "messageId"));
  const finalMessageId = validBindings.at(-1)?.contextBinding?.messageId;
  if (
    contextMessageId === INVALID_SCOPE_VALUE ||
    (finalMessageId !== undefined && contextMessageId !== finalMessageId)
  ) {
    valid = false;
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
              identifierAuthentication: binding.identifierAuthentication,
            }),
          }),
        });
      })
    : [];
  state.evidenceByPreparation.set(
    preparation,
    valid ? combineChannelAdmissionEvidence(sources) : unknownChannelAdmissionEvidence(),
  );
  if (valid && params.owner?.resolveGatewayContext) {
    state.gatewayResolverByPreparation.set(preparation, params.owner.resolveGatewayContext);
  }
  return preparation;
}

/** Attach one prepared private carrier to the exact finalized context scope. */
export function bindHostChannelContextAdmissionEvidence(params: {
  context: object;
  preparation: PreparedChannelAdmissionEvidence;
}): void {
  const preparedEvidence = state.evidenceByPreparation.get(params.preparation);
  const gatewayContextResolver = state.gatewayResolverByPreparation.get(params.preparation);
  state.evidenceByPreparation.delete(params.preparation);
  state.gatewayResolverByPreparation.delete(params.preparation);
  const scopeKey = finalizedContextScopeKey(params.context);
  if (gatewayContextResolver && scopeKey !== undefined) {
    state.gatewayResolverByContext.set(params.context, gatewayContextResolver);
    state.scopeByContext.set(params.context, scopeKey);
  }
  if (!state.collectionEnabled) {
    return;
  }
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

export function readChannelContextGatewayContextResolver(
  context: object,
): GatewayContextResolver | undefined {
  return state.gatewayResolverByContext.get(context);
}

/** Preserve private evidence when an owner intentionally replaces a finalized context object. */
export function copyChannelParticipantAdmissionEvidence(source: object, target: object): void {
  const evidence = state.evidenceByContext.get(source);
  const gatewayContextResolver = state.gatewayResolverByContext.get(source);
  if (!evidence && !gatewayContextResolver) {
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
  if (gatewayContextResolver && sourceScope !== undefined && targetScope === sourceScope) {
    const currentResolver = state.gatewayResolverByContext.get(target);
    if (currentResolver && currentResolver !== gatewayContextResolver) {
      state.gatewayResolverByContext.delete(target);
      state.gatewayResolverConflictsByContext.add(target);
    } else if (!state.gatewayResolverConflictsByContext.has(target)) {
      state.gatewayResolverByContext.set(target, gatewayContextResolver);
      state.scopeByContext.set(target, sourceScope);
    }
  }
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
      identifierAuthentication: "unknown",
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
      identifierAuthentication: "unknown",
    });
  }

  const everyDecisionEnforced = contributions.every(
    (item) => item.decision?.participantAware && item.decision.outcomeAffecting,
  );
  const identifierAuthentication = contributions.some(
    (item) => item.decision?.identifierAuthentication === "affected",
  )
    ? "affected"
    : contributions.some((item) => item.decision?.identifierAuthentication === "evaluated")
      ? "evaluated"
      : contributions.every((item) => item.decision?.identifierAuthentication === "not-evaluated")
        ? "not-evaluated"
        : "unknown";
  return freezeConsumed({
    ingressState: "present",
    invoker: {
      state: "present",
      kind: "person",
      rawPrincipalRef: present[0].rawPrincipalRef,
    },
    assuranceRef: "channel-admission",
    decisionCoverage: everyDecisionEnforced ? "enforced" : "attribution-only",
    identifierAuthentication,
  });
}

/** Queue the channel decision after its exact identity tuple on the shared audit FIFO. */
export function recordChannelAdmissionDecision(params: {
  contextId: ChannelAdmissionDecisionReceiptInput["contextId"];
  executionId: ChannelAdmissionDecisionReceiptInput["executionId"];
  runId: ChannelAdmissionDecisionReceiptInput["runId"];
  occurredAt: ChannelAdmissionDecisionReceiptInput["occurredAt"];
  coverageState: ChannelAdmissionDecisionReceiptInput["coverageState"];
  identifierAuthentication: ChannelAdmissionDecisionReceiptInput["identifierAuthentication"];
}): boolean {
  return state.decisionSink?.(createChannelAdmissionDecisionReceipt(params)) ?? false;
}
