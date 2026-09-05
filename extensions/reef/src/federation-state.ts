import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  REEF_FEDERATION_NAMESPACE,
  validateReefFederationBody,
  type ReefFederationFrame,
} from "../protocol/federation.js";
import {
  ReefPeerIdentitySchema,
  sameReefPeerIdentity,
  type ReefPeerIdentity,
} from "./friend-types.js";

const REEF_FEDERATION_PROPOSALS_NAMESPACE = "federation-proposals";
const REEF_FEDERATION_OUTBOUND_PROPOSALS_NAMESPACE = "federation-outbound-proposals";
const REEF_FEDERATION_PROPOSALS_MAX_ENTRIES = 5_000;
const REEF_FEDERATION_PROPOSALS_MAX_ENTRIES_PER_PEER = 128;
const REEF_FEDERATION_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60_000;

type CrossSessionGrant = NonNullable<ReturnType<PluginRuntime["crossSessionGrants"]["get"]>>;
type CrossSessionGrantCreate = Parameters<PluginRuntime["crossSessionGrants"]["create"]>[0];
type CrossSessionGrantAuthority = Parameters<PluginRuntime["crossSessionGrants"]["authorize"]>[0];

export type ReefFederationMount = {
  mountId: string;
  peer: string;
  peerIdentity: ReefPeerIdentity;
  role: "host" | "guest";
  sessionKey: string;
  sessionId: string;
  grantGeneration: number;
  allowAlways: boolean;
  revoked: boolean;
  revocationPending?: boolean;
};

export type ReefGrantAuthority = {
  mountId: string;
  peer: string;
  peerIdentity: ReefPeerIdentity;
  sessionId: string;
  generation: number;
};

export type ReefFederationPromptRequest = {
  from: string;
  to: string;
  peer: string;
  peerIdentity: ReefPeerIdentity;
  frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>;
};

export type ReefFederationProposal = {
  proposalId: string;
  mountId: string;
  digest: string;
  status: "pending" | "accepted" | "denied" | "failed";
  request: ReefFederationPromptRequest;
  outcome?: Exclude<
    ReefFederationFrame,
    { type: "session.mount.offer" | "session.prompt.propose" }
  >;
  outcomeSentAt?: number;
  outcomeAbandonedAt?: number;
  outcomeAbandonReason?: "peer-identity-changed";
  approvalId?: string;
  approvalDecision?: "allow-once";
  runId?: string;
  failureCode?: string;
};

export type ReefFederationPromptOutcome = Extract<
  ReefFederationFrame,
  {
    type: "session.prompt.accepted" | "session.prompt.denied" | "session.prompt.failed";
  }
>;

type ReefOutboundProposal = ReefFederationPromptRequest & {
  outcome?: ReefFederationPromptOutcome;
  outcomeReceivedAt?: number;
};

export type ReefFederationProposalResolution = Pick<ReefFederationProposal, "status"> &
  Partial<
    Pick<
      ReefFederationProposal,
      "approvalId" | "approvalDecision" | "runId" | "failureCode" | "outcome"
    >
  >;

/** Reef transport projection over host-owned grants plus durable proposal replay outcomes. */
export class ReefFederationState {
  readonly #grants: PluginRuntime["crossSessionGrants"];
  readonly #proposals: PluginStateSyncKeyedStore<ReefFederationProposal>;
  readonly #outboundProposals: PluginStateSyncKeyedStore<ReefOutboundProposal>;

  constructor(
    runtime: PluginRuntime,
    private readonly authoritySignal: AbortSignal,
    private readonly localIdentityBinding = "test-local-identity",
  ) {
    if (!localIdentityBinding) {
      throw new Error("Reef federation requires a local identity binding");
    }
    this.#grants = runtime.crossSessionGrants;
    this.#proposals = runtime.state.openSyncKeyedStore<ReefFederationProposal>({
      namespace: REEF_FEDERATION_PROPOSALS_NAMESPACE,
      maxEntries: REEF_FEDERATION_PROPOSALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_FEDERATION_PROPOSAL_TTL_MS,
    });
    this.#outboundProposals = runtime.state.openSyncKeyedStore<ReefOutboundProposal>({
      namespace: REEF_FEDERATION_OUTBOUND_PROPOSALS_NAMESPACE,
      maxEntries: REEF_FEDERATION_PROPOSALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_FEDERATION_PROPOSAL_TTL_MS,
    });
  }

  /** Persist transport metadata through the host-owned cross-session grant authority. */
  createMount(mount: ReefFederationMount): boolean {
    return this.#grants.create(
      toCrossSessionGrant(validateMount(mount), this.localIdentityBinding),
      this.authoritySignal,
    );
  }

  /** List mounts projected from host-owned grant records. */
  listMounts(): ReefFederationMount[] {
    return this.#grants.list(this.authoritySignal).map(fromCrossSessionGrant);
  }

  /** Read one mount projected from its host-owned grant record. */
  getMount(mountId: string): ReefFederationMount | undefined {
    const grant = this.#grants.get(mountId, this.authoritySignal);
    return grant ? fromCrossSessionGrant(grant) : undefined;
  }

  /** Revalidate exact lifecycle and transport authority before privileged use. */
  authorizeMount(params: ReefGrantAuthority): ReefFederationMount | undefined {
    const grant = this.#grants.authorize(
      toGrantAuthority(params, this.authoritySignal, this.localIdentityBinding),
    );
    return grant ? fromCrossSessionGrant(grant) : undefined;
  }

  /** Persist standing authority only after core revalidates the exact live grant. */
  allowAlways(params: ReefGrantAuthority): boolean {
    return this.#grants.allowStanding(
      toGrantAuthority(params, this.authoritySignal, this.localIdentityBinding),
    );
  }

  /** Revoke a standing grant, or return its committed generation for idempotent delivery. */
  revoke(mountId: string, expectedGeneration: number): ReefFederationMount | undefined {
    const grant = this.#grants.revoke({
      grantId: mountId,
      expectedGeneration,
      signal: this.authoritySignal,
    });
    return grant ? fromCrossSessionGrant(grant) : undefined;
  }

  /** Apply a peer-issued revocation only to that peer's exact holder grant. */
  applyRevocation(params: ReefGrantAuthority): boolean {
    return this.#grants.applyRevocation(
      toGrantAuthority(params, this.authoritySignal, this.localIdentityBinding),
    );
  }

  /** Stop durable revocation recovery after the exact generation reaches transport. */
  acknowledgeRevocation(mountId: string, generation: number): boolean {
    return this.#grants.acknowledgeRevocation({
      grantId: mountId,
      generation,
      signal: this.authoritySignal,
    });
  }

  /** Find an unresolved outbound proposal so command retry preserves its idempotency key. */
  findOutboundProposal(
    mount: ReefFederationMount,
    text: string,
  ): ReefFederationPromptRequest | undefined {
    const proposal = this.#outboundProposals
      .entries()
      .map((entry) => validateOutboundProposal(entry.value))
      .find(
        (entry) =>
          !entry.outcome &&
          entry.peer === mount.peer &&
          sameReefPeerIdentity(entry.peerIdentity, mount.peerIdentity) &&
          entry.frame.mountId === mount.mountId &&
          entry.frame.sessionId === mount.sessionId &&
          entry.frame.grantGeneration === mount.grantGeneration &&
          entry.frame.text === text,
      );
    return proposal ? validatePromptRequest(proposal) : undefined;
  }

  /** Reserve an outbound proposal before its transport outcome becomes ambiguous. */
  registerOutboundProposal(request: ReefFederationPromptRequest): boolean {
    const validated = validatePromptRequest(request);
    const existing = this.#outboundProposals.lookup(outboundProposalKey(request.frame.proposalId));
    if (existing) {
      return matchesPromptRequest(validateOutboundProposal(existing), validated);
    }
    const peerCount = this.#outboundProposals
      .entries()
      .map((entry) => validateOutboundProposal(entry.value))
      .filter((entry) => entry.peer === validated.peer).length;
    return (
      peerCount < REEF_FEDERATION_PROPOSALS_MAX_ENTRIES_PER_PEER &&
      this.#outboundProposals.registerIfAbsent(
        outboundProposalKey(validated.frame.proposalId),
        validated,
      )
    );
  }

  /** Accept one terminal outcome only for its exact guest mount and outbound proposal binding. */
  acceptOutboundOutcome(
    peer: string,
    peerIdentity: ReefPeerIdentity,
    outcome: ReefFederationPromptOutcome,
  ): "accepted" | "duplicate" | "invalid" {
    let result: "accepted" | "duplicate" | "invalid" = "invalid";
    const update = this.#outboundProposals.update;
    if (!update) {
      throw new Error("Reef outbound proposals require atomic plugin-state updates");
    }
    update(outboundProposalKey(outcome.proposalId), (existing) => {
      if (!existing) {
        return existing;
      }
      const proposal = validateOutboundProposal(existing);
      if (
        proposal.peer !== peer ||
        !sameReefPeerIdentity(proposal.peerIdentity, peerIdentity) ||
        proposal.frame.mountId !== outcome.mountId ||
        proposal.frame.sessionId !== outcome.sessionId ||
        proposal.frame.proposalId !== outcome.proposalId
      ) {
        return proposal;
      }
      if (proposal.outcome) {
        result = "duplicate";
        return proposal;
      }
      result = "accepted";
      return validateOutboundProposal({
        ...proposal,
        outcome,
        outcomeReceivedAt: Date.now(),
      });
    });
    return result;
  }

  /** Claim an inbound request before transport acknowledgement. */
  claimPrompt(
    request: ReefFederationPromptRequest,
  ): "new" | "duplicate" | "mismatch" | "peer-capacity" {
    return this.claimProposal({
      proposalId: request.frame.proposalId,
      mountId: request.frame.mountId,
      digest: request.frame.textSha256,
      status: "pending",
      request: structuredClone(request),
    }).result;
  }

  /** Claim one exact proposal; duplicate IDs return the prior outcome, while digest reuse fails. */
  claimProposal(proposal: ReefFederationProposal): {
    result: "new" | "duplicate" | "mismatch" | "peer-capacity";
    proposal: ReefFederationProposal;
  } {
    validateProposal(proposal);
    const key = proposalKey(proposal.proposalId, proposal.digest);
    const existing = this.#proposals.lookup(key);
    if (!existing) {
      const retained = this.#proposals.entries().map((entry) => validateProposal(entry.value));
      const peerProposalCount = retained.filter(
        (entry) => entry.request.peer === proposal.request.peer,
      ).length;
      if (
        retained.length >= REEF_FEDERATION_PROPOSALS_MAX_ENTRIES ||
        peerProposalCount >= REEF_FEDERATION_PROPOSALS_MAX_ENTRIES_PER_PEER
      ) {
        return { result: "peer-capacity", proposal: structuredClone(proposal) };
      }
      const rebound = retained.some(
        (entry) => entry.proposalId === proposal.proposalId && entry.digest !== proposal.digest,
      );
      if (rebound) {
        let current = proposal;
        const update = this.#proposals.update;
        if (!update) {
          throw new Error("Reef federation proposals require atomic plugin-state updates");
        }
        update(key, (currentValue) => {
          current = currentValue ? validateProposal(currentValue) : structuredClone(proposal);
          return current;
        });
        return { result: "mismatch", proposal: structuredClone(current) };
      }
    }

    let result: "new" | "duplicate" = "new";
    let current = proposal;
    const update = this.#proposals.update;
    if (!update) {
      throw new Error("Reef federation proposals require atomic plugin-state updates");
    }
    update(key, (currentValue) => {
      if (!currentValue) {
        return structuredClone(proposal);
      }
      current = validateProposal(currentValue);
      result = "duplicate";
      return currentValue;
    });
    return { result, proposal: structuredClone(current) };
  }

  /** List durable prompt work whose terminal outcome has not reached the peer. */
  listUnsentProposals(): ReefFederationProposal[] {
    return this.#proposals
      .entries()
      .map((entry) => validateProposal(entry.value))
      .filter(
        (proposal) =>
          proposal.outcomeSentAt === undefined && proposal.outcomeAbandonedAt === undefined,
      );
  }

  /** Record a proposal outcome only while its exact digest remains authoritative. */
  resolveProposal(
    proposalId: string,
    digest: string,
    outcome: ReefFederationProposalResolution,
  ): ReefFederationProposal | undefined {
    let resolved: ReefFederationProposal | undefined;
    const update = this.#proposals.update;
    if (!update) {
      throw new Error("Reef federation proposals require atomic plugin-state updates");
    }
    update(proposalKey(proposalId, digest), (existing) => {
      if (!existing || existing.digest !== digest) {
        return existing;
      }
      resolved = validateProposal({ ...existing, ...outcome });
      return resolved;
    });
    return resolved;
  }

  /** Mark one exact terminal outcome as handed to the Reef transport. */
  markOutcomeSent(proposalId: string, digest: string): boolean {
    let changed = false;
    const update = this.#proposals.update;
    if (!update) {
      throw new Error("Reef federation proposals require atomic plugin-state updates");
    }
    update(proposalKey(proposalId, digest), (existing) => {
      if (
        !existing ||
        existing.digest !== digest ||
        !existing.outcome ||
        existing.outcomeAbandonedAt !== undefined
      ) {
        return existing;
      }
      changed = true;
      return validateProposal({ ...existing, outcomeSentAt: Date.now() });
    });
    return changed;
  }

  /** Record that identity rotation made one terminal outcome permanently undeliverable. */
  abandonOutcome(proposalId: string, digest: string): boolean {
    let changed = false;
    const update = this.#proposals.update;
    if (!update) {
      throw new Error("Reef federation proposals require atomic plugin-state updates");
    }
    update(proposalKey(proposalId, digest), (existing) => {
      if (
        !existing ||
        existing.digest !== digest ||
        !existing.outcome ||
        existing.outcomeSentAt !== undefined
      ) {
        return existing;
      }
      changed = true;
      return validateProposal({
        ...existing,
        outcomeAbandonedAt: Date.now(),
        outcomeAbandonReason: "peer-identity-changed",
      });
    });
    return changed;
  }
}

function toCrossSessionGrant(
  mount: ReefFederationMount,
  localIdentityBinding: string,
): CrossSessionGrantCreate {
  return {
    grantId: mount.mountId,
    subjectId: mount.peer,
    subjectBinding: `${localIdentityBinding}|${peerIdentityBinding(mount.peerIdentity)}`,
    role: mount.role === "host" ? "issuer" : "holder",
    targetSessionKey: mount.sessionKey,
    targetSessionId: mount.sessionId,
    generation: mount.grantGeneration,
  };
}

function fromCrossSessionGrant(grant: CrossSessionGrant): ReefFederationMount {
  const remoteBinding = grant.subjectBinding.split("|").at(-1) ?? "";
  const [epoch, ed25519PublicKey, x25519PublicKey] = remoteBinding.split(":");
  return validateMount({
    mountId: grant.grantId,
    peer: grant.subjectId,
    peerIdentity: {
      keyEpoch: Number(epoch),
      ed25519PublicKey: ed25519PublicKey ?? "",
      x25519PublicKey: x25519PublicKey ?? "",
    },
    role: grant.role === "issuer" ? "host" : "guest",
    sessionKey: grant.targetSessionKey,
    sessionId: grant.targetSessionId,
    grantGeneration: grant.generation,
    allowAlways: grant.standing,
    revoked: grant.revoked,
    revocationPending: grant.revocationPending,
  });
}

function toGrantAuthority(
  params: ReefGrantAuthority,
  authoritySignal: AbortSignal,
  localIdentityBinding: string,
): CrossSessionGrantAuthority {
  return {
    grantId: params.mountId,
    subjectId: params.peer,
    subjectBinding: `${localIdentityBinding}|${peerIdentityBinding(params.peerIdentity)}`,
    targetSessionId: params.sessionId,
    generation: params.generation,
    signal: authoritySignal,
  };
}

function peerIdentityBinding(identity: ReefPeerIdentity): string {
  return `${identity.keyEpoch}:${identity.ed25519PublicKey}:${identity.x25519PublicKey}`;
}

function proposalKey(proposalId: string, digest: string): string {
  return `proposal:${hashKey(`${proposalId}:${digest}`)}`;
}

function outboundProposalKey(proposalId: string): string {
  return `outbound-proposal:${hashKey(proposalId)}`;
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateMount(value: ReefFederationMount): ReefFederationMount {
  if (
    !value ||
    typeof value.mountId !== "string" ||
    typeof value.peer !== "string" ||
    !ReefPeerIdentitySchema.safeParse(value.peerIdentity).success ||
    !["host", "guest"].includes(value.role) ||
    typeof value.sessionKey !== "string" ||
    typeof value.sessionId !== "string" ||
    !Number.isSafeInteger(value.grantGeneration) ||
    value.grantGeneration < 0 ||
    typeof value.allowAlways !== "boolean" ||
    typeof value.revoked !== "boolean" ||
    (value.revocationPending !== undefined && typeof value.revocationPending !== "boolean")
  ) {
    throw new Error("invalid Reef federation mount");
  }
  return structuredClone(value);
}

function validatePromptRequest(value: ReefFederationPromptRequest): ReefFederationPromptRequest {
  if (
    !value ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    typeof value.peer !== "string" ||
    !ReefPeerIdentitySchema.safeParse(value.peerIdentity).success
  ) {
    throw new Error("invalid Reef outbound proposal request");
  }
  validateReefFederationBody({ namespace: REEF_FEDERATION_NAMESPACE, frame: value.frame });
  if (value.frame.type !== "session.prompt.propose") {
    throw new Error("invalid Reef outbound proposal frame");
  }
  return structuredClone(value);
}

function validateOutboundProposal(value: ReefOutboundProposal): ReefOutboundProposal {
  const request = validatePromptRequest(value);
  if (
    (value.outcomeReceivedAt !== undefined && !Number.isFinite(value.outcomeReceivedAt)) ||
    (value.outcomeReceivedAt === undefined) !== (value.outcome === undefined)
  ) {
    throw new Error("invalid Reef outbound proposal outcome");
  }
  if (value.outcome) {
    validateReefFederationBody({ namespace: REEF_FEDERATION_NAMESPACE, frame: value.outcome });
  }
  return structuredClone({ ...request, ...value });
}

function matchesPromptRequest(
  left: ReefFederationPromptRequest,
  right: ReefFederationPromptRequest,
): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.peer === right.peer &&
    sameReefPeerIdentity(left.peerIdentity, right.peerIdentity) &&
    JSON.stringify(left.frame) === JSON.stringify(right.frame)
  );
}

function validateProposal(value: ReefFederationProposal): ReefFederationProposal {
  if (
    !value ||
    typeof value.proposalId !== "string" ||
    typeof value.mountId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !["pending", "accepted", "denied", "failed"].includes(value.status) ||
    !value.request ||
    typeof value.request.from !== "string" ||
    typeof value.request.to !== "string" ||
    typeof value.request.peer !== "string" ||
    !ReefPeerIdentitySchema.safeParse(value.request.peerIdentity).success ||
    (value.outcomeSentAt !== undefined && !Number.isFinite(value.outcomeSentAt)) ||
    (value.outcomeAbandonedAt !== undefined && !Number.isFinite(value.outcomeAbandonedAt)) ||
    (value.outcomeAbandonReason !== undefined &&
      value.outcomeAbandonReason !== "peer-identity-changed") ||
    (value.approvalDecision !== undefined && value.approvalDecision !== "allow-once") ||
    (value.approvalDecision !== undefined && typeof value.approvalId !== "string") ||
    (value.outcomeAbandonedAt === undefined) !== (value.outcomeAbandonReason === undefined) ||
    (value.outcomeSentAt !== undefined && value.outcomeAbandonedAt !== undefined)
  ) {
    throw new Error("invalid Reef federation proposal");
  }
  validateReefFederationBody({
    namespace: REEF_FEDERATION_NAMESPACE,
    frame: value.request.frame,
  });
  if (value.outcome) {
    validateReefFederationBody({ namespace: REEF_FEDERATION_NAMESPACE, frame: value.outcome });
  }
  if ((value.status === "pending") === Boolean(value.outcome)) {
    throw new Error("invalid Reef federation proposal outcome");
  }
  return structuredClone(value);
}
