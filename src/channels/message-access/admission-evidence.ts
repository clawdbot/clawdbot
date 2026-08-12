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

const CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS = 16;
const CHANNEL_ADMISSION_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CHANNEL_ADMISSION_EVIDENCE_STATE_KEY = Symbol.for("openclaw.channelAdmissionEvidenceState");
const state = resolveGlobalSingleton(CHANNEL_ADMISSION_EVIDENCE_STATE_KEY, () => ({
  collectionEnabled: false,
  generation: 0,
  payloadByEvidence: new WeakMap<object, ChannelAdmissionEvidencePayload>(),
  evidenceByIngress: new WeakMap<object, ChannelAdmissionEvidence>(),
  evidenceByContext: new WeakMap<object, ChannelAdmissionEvidence>(),
  consumedEvidence: new WeakSet<object>(),
  decisionSink: undefined as ((receipt: DecisionReceiptV1) => boolean) | undefined,
}));

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
  const channelId = params.channelId.trim();
  const accountId = params.accountId?.trim() || "default";
  const rawPrincipalRef =
    params.rawPrincipalRef == null ? "" : String(params.rawPrincipalRef).trim();
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

/** Explicit attribution-only mint for adapters whose access result is owned elsewhere. */
export function createChannelParticipantAdmissionEvidence(params: {
  channelId: string;
  accountId?: string;
  participantId: string | number | null | undefined;
}): ChannelAdmissionEvidence | undefined {
  return mintChannelAdmissionEvidence({
    kind: "leaf",
    contribution: participantContribution({
      channelId: params.channelId,
      accountId: params.accountId,
      rawPrincipalRef: params.participantId,
    }),
  });
}

/** Bind an admitted resolver result to its host-owned participant without exposing that value. */
export function bindChannelIngressAdmissionEvidence(params: {
  result: ResolvedChannelMessageIngress;
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
  participantOutcomeAffecting: boolean;
}): ResolvedChannelMessageIngress {
  if (!state.collectionEnabled || params.result.ingress.admission !== "dispatch") {
    return params.result;
  }
  const contribution = participantContribution(params);
  const evidence = mintChannelAdmissionEvidence({
    kind: "leaf",
    contribution: Object.freeze({
      ...contribution,
      decision: Object.freeze({
        participantAware: contribution.participant.state === "present",
        outcomeAffecting: params.participantOutcomeAffecting,
      }),
    }),
  });
  if (evidence) {
    state.evidenceByIngress.set(params.result, evidence);
  }
  return params.result;
}

function evidenceMatchesContextParticipant(params: {
  evidence: ChannelAdmissionEvidence;
  channelId: string;
  accountId?: string;
  rawPrincipalRef: string | number | null | undefined;
}): boolean {
  const expected = scopedParticipantRef(params);
  const payload = state.payloadByEvidence.get(params.evidence);
  return (
    payload?.kind === "leaf" &&
    payload.contribution.participant.state === "present" &&
    payload.contribution.participant.rawPrincipalRef === expected
  );
}

/** Attach private evidence to the finalized context returned by the existing SDK builder. */
export function bindChannelContextAdmissionEvidence(params: {
  context: object;
  channelId: string;
  accountId?: string;
  ingress?: ResolvedChannelMessageIngress | "unsupported";
  evidence?: ChannelAdmissionEvidence;
  rawPrincipalRef: string | number | null | undefined;
}): void {
  if (!state.collectionEnabled) {
    return;
  }
  const ingressEvidence =
    params.ingress && params.ingress !== "unsupported"
      ? state.evidenceByIngress.get(params.ingress)
      : undefined;
  const evidence = params.evidence
    ? evidenceMatchesContextParticipant({ ...params, evidence: params.evidence })
      ? params.evidence
      : mintChannelAdmissionEvidence({
          kind: "leaf",
          contribution: Object.freeze({ participant: { state: "unknown" as const } }),
        })
    : params.ingress === "unsupported"
      ? mintChannelAdmissionEvidence({
          kind: "leaf",
          contribution: Object.freeze({ participant: { state: "unsupported" as const } }),
        })
      : ingressEvidence &&
          evidenceMatchesContextParticipant({ ...params, evidence: ingressEvidence })
        ? ingressEvidence
        : params.ingress
          ? mintChannelAdmissionEvidence({
              kind: "leaf",
              contribution: Object.freeze({ participant: { state: "unknown" as const } }),
            })
          : mintChannelAdmissionEvidence({
              kind: "leaf",
              contribution: Object.freeze({ participant: { state: "unknown" as const } }),
            });
  if (evidence) {
    state.evidenceByContext.set(params.context, evidence);
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
  if (evidence) {
    state.evidenceByContext.set(target, evidence);
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
