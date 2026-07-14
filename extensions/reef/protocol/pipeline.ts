import { sha256 } from "@noble/hashes/sha2.js";
import { appendAudit, type AuditStore } from "./audit.js";
import { canonicalBytes } from "./canonical.js";
import { deterministicChecks } from "./checks.js";
import { fromBase64url, hex } from "./encoding.js";
import {
  bodyHash,
  openClaimed,
  ReplayedError,
  seal,
  validateEnvelopeMetadata,
  validateMessageBody,
  type Envelope,
  type MessageBody,
} from "./envelope.js";
import {
  admitVerdict,
  type GuardAdapter,
  type GuardDirection,
  type GuardRequest,
  type Verdict,
} from "./guard.js";
import { parseHandleEpoch } from "./identity.js";
import { signReceipt, type SignedReceipt } from "./receipts.js";
import type { ReplayStore } from "./replay.js";

export interface ReviewRequest {
  id: string;
  from: string;
  to: string;
  direction: GuardDirection;
  bodyHash: string;
  approvalDigest: string;
  verdict: Verdict;
}

export interface ReviewApproval {
  approved: boolean;
  approvalDigest: string;
}

export type ReviewGate = (request: ReviewRequest) => Promise<ReviewApproval | undefined>;

export class PipelineError extends Error {
  constructor(
    readonly stage: "deterministic" | "guard" | "review",
    message: string,
    readonly verdict?: Verdict,
    readonly receipt?: SignedReceipt,
    readonly reviewOutcome?: "pending" | "denied",
    readonly approvalDigest?: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

interface GuardedPipelineOptions {
  guard: GuardAdapter;
  audit: AuditStore;
  policyVersion: string;
  reviewGate?: ReviewGate;
}

export interface ComposeOutboundOptions extends GuardedPipelineOptions {
  id: string;
  from: string;
  to: string;
  body: MessageBody;
  senderSigningSecretKey: string;
  recipientEncryptionPublicKey: string;
  ts?: number;
  rng?: (length: number) => Uint8Array;
}

export interface OutboundResult {
  envelope: Envelope;
  verdict: Verdict;
}

export async function composeOutbound(options: ComposeOutboundOptions): Promise<OutboundResult> {
  validateEnvelopeMetadata(
    options.id,
    options.from,
    options.to,
    options.ts ?? Math.floor(Date.now() / 1000),
  );
  validateMessageBody(options.body);
  if (
    fromBase64url(options.senderSigningSecretKey).length !== 32 ||
    fromBase64url(options.recipientEncryptionPublicKey).length !== 32
  ) {
    throw new Error("invalid outbound key material");
  }
  const checks = deterministicChecks(options.body.text);
  if (
    checks.findings.some(
      (finding) => finding.code === "invalid_utf8" || finding.code === "too_large",
    )
  ) {
    throw new PipelineError("deterministic", "invalid outbound message");
  }
  const proposalHash = bodyHash(options.body);
  const approvalDigest = computeApprovalDigest(
    options.id,
    options.from,
    options.to,
    "outbound",
    proposalHash,
    options.policyVersion,
  );
  await appendAudit(options.audit, "proposal", {
    id: options.id,
    from: options.from,
    to: options.to,
    bodyHash: proposalHash,
    approvalDigest,
    body: options.body,
  });
  if (!checks.allowed) {
    await appendAudit(options.audit, "deterministic_verdict", {
      id: options.id,
      approvalDigest,
      decision: "deny",
      findings: checks.findings,
    });
    throw new PipelineError("deterministic", "deterministic checks denied message");
  }
  const verdict = await classifyWithReview(
    options,
    "outbound",
    options.id,
    proposalHash,
    approvalDigest,
    options.from,
    options.to,
    options.body.text,
  );
  const envelope = seal(options);
  await appendAudit(options.audit, "envelope", { id: options.id, approvalDigest, envelope });
  return { envelope, verdict };
}

export interface ComposeInboundOptions extends GuardedPipelineOptions {
  envelope: Envelope;
  self: string;
  recipientEncryptionSecretKey: string;
  recipientSigningSecretKey: string;
  senderSigningPublicKey?: string;
  replayStore: ReplayStore;
  now?: number;
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
}

export type InboundResult =
  | { disposition: "accepted"; body: MessageBody; verdict: Verdict; receipt: SignedReceipt }
  | { disposition: "duplicate"; body?: MessageBody; receipt: SignedReceipt };

// Caller MUST ack the relay with receipt. For accepted or duplicate-accepted results, it MUST
// idempotently deliver every present body to channel ingress, keyed by envelope id.
export async function composeInbound(options: ComposeInboundOptions): Promise<InboundResult> {
  const opened = await openClaimed(options);
  if (opened.claim === "duplicate") {
    if (opened.receipt === undefined) {
      throw new ReplayedError("duplicate envelope");
    }
    return opened.body === undefined
      ? { disposition: "duplicate", receipt: opened.receipt }
      : { disposition: "duplicate", body: opened.body, receipt: opened.receipt };
  }
  let finalized = false;
  const peer = parseHandleEpoch(options.envelope.from).handle;
  try {
    const proposalHash = bodyHash(opened.body);
    const approvalDigest = computeApprovalDigest(
      options.envelope.id,
      options.envelope.from,
      options.self,
      "inbound",
      proposalHash,
      options.policyVersion,
    );
    const checks = deterministicChecks(opened.body.text);
    if (!checks.allowed) {
      await appendAudit(options.audit, "deterministic_verdict", {
        id: options.envelope.id,
        approvalDigest,
        decision: "deny",
        findings: checks.findings,
      });
      const receipt = await completeRejection(
        options,
        peer,
        proposalHash,
        approvalDigest,
        "deterministic_deny",
      );
      finalized = true;
      throw new PipelineError(
        "deterministic",
        "deterministic checks denied message",
        undefined,
        receipt,
      );
    }
    let verdict: Verdict;
    try {
      verdict = await classifyWithReview(
        options,
        "inbound",
        options.envelope.id,
        proposalHash,
        approvalDigest,
        options.envelope.from,
        options.self,
        opened.body.text,
      );
    } catch (error) {
      if (
        error instanceof PipelineError &&
        error.stage === "guard" &&
        error.verdict?.decision === "deny"
      ) {
        const receipt = await completeRejection(
          options,
          peer,
          proposalHash,
          approvalDigest,
          "guard_deny",
        );
        finalized = true;
        throw new PipelineError("guard", error.message, error.verdict, receipt);
      }
      if (
        error instanceof PipelineError &&
        error.stage === "review" &&
        error.reviewOutcome === "denied"
      ) {
        const receipt = await completeRejection(
          options,
          peer,
          proposalHash,
          approvalDigest,
          "review_denied",
        );
        finalized = true;
        throw new PipelineError(
          "review",
          error.message,
          error.verdict,
          receipt,
          "denied",
          approvalDigest,
        );
      }
      throw error;
    }
    const inboxEntry = await appendAudit(options.audit, "inbox", {
      id: options.envelope.id,
      bodyHash: proposalHash,
      approvalDigest,
      text: opened.body.text,
      verdict,
    });
    const receipt = signReceipt(
      {
        id: options.envelope.id,
        bodyHash: proposalHash,
        auditHead: inboxEntry.entryHash,
        status: "accepted",
      },
      options.recipientSigningSecretKey,
    );
    await appendAudit(options.audit, "receipt", {
      id: options.envelope.id,
      approvalDigest,
      receipt,
    });
    await options.replayStore.complete(peer, options.envelope.id, receipt, opened.body);
    finalized = true;
    return { disposition: "accepted", body: opened.body, verdict, receipt };
  } catch (error) {
    if (!finalized) {
      await options.replayStore.release(peer, options.envelope.id);
    }
    throw error;
  }
}

async function completeRejection(
  options: ComposeInboundOptions,
  peer: string,
  proposalHash: string,
  approvalDigest: string,
  category: string,
): Promise<SignedReceipt> {
  const rejectionEntry = await appendAudit(options.audit, "inbox_rejected", {
    id: options.envelope.id,
    bodyHash: proposalHash,
    approvalDigest,
    decision: "deny",
    category,
  });
  const receipt = signReceipt(
    {
      id: options.envelope.id,
      bodyHash: proposalHash,
      auditHead: rejectionEntry.entryHash,
      status: "rejected",
      category,
    },
    options.recipientSigningSecretKey,
  );
  await appendAudit(options.audit, "receipt", { id: options.envelope.id, approvalDigest, receipt });
  await options.replayStore.complete(peer, options.envelope.id, receipt);
  return receipt;
}

async function classifyWithReview(
  options: GuardedPipelineOptions,
  direction: GuardDirection,
  id: string,
  proposalHash: string,
  approvalDigest: string,
  source: string,
  destination: string,
  text: string,
): Promise<Verdict> {
  const request: GuardRequest = {
    direction,
    source,
    destination,
    text,
    policyVersion: options.policyVersion,
  };
  let verdict = admitVerdict(
    await options.guard.classify(request),
    options.guard.pinnedModel,
    request.policyVersion,
  );
  await appendAudit(options.audit, "guard_verdict", {
    id,
    from: source,
    to: destination,
    direction,
    bodyHash: proposalHash,
    approvalDigest,
    ...verdict,
  });
  if (verdict.decision === "deny") {
    throw new PipelineError("guard", "guard denied message", verdict);
  }
  if (verdict.decision === "review") {
    const approval = await options.reviewGate?.({
      id,
      from: source,
      to: destination,
      direction,
      bodyHash: proposalHash,
      approvalDigest,
      verdict,
    });
    if (approval === undefined) {
      throw new PipelineError(
        "review",
        "review approval pending",
        verdict,
        undefined,
        "pending",
        approvalDigest,
      );
    }
    if (approval.approvalDigest !== approvalDigest) {
      throw new PipelineError(
        "review",
        "approval digest mismatch",
        verdict,
        undefined,
        "pending",
        approvalDigest,
      );
    }
    if (!approval.approved) {
      throw new PipelineError(
        "review",
        "review explicitly denied",
        verdict,
        undefined,
        "denied",
        approvalDigest,
      );
    }
    await appendAudit(options.audit, "review_approval", {
      id,
      from: source,
      to: destination,
      direction,
      bodyHash: proposalHash,
      approvalDigest,
      approved: true,
    });
    verdict = admitVerdict(
      await options.guard.classify(request),
      options.guard.pinnedModel,
      request.policyVersion,
    );
    await appendAudit(options.audit, "guard_verdict", {
      id,
      from: source,
      to: destination,
      direction,
      bodyHash: proposalHash,
      approvalDigest,
      afterApproval: true,
      ...verdict,
    });
    if (verdict.decision === "deny") {
      throw new PipelineError("guard", "guard denied approved message", verdict);
    }
  }
  return verdict;
}

function computeApprovalDigest(
  id: string,
  from: string,
  to: string,
  direction: GuardDirection,
  proposalHash: string,
  policyVersion: string,
): string {
  return hex(
    sha256(canonicalBytes({ id, from, to, direction, bodyHash: proposalHash, policyVersion })),
  );
}
