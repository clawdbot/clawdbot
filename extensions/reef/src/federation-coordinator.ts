import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  createReefFederatedPromptDigest,
  type ReefFederationFrame,
} from "../protocol/federation.js";
import type {
  ReefFederationMount,
  ReefFederationProposal,
  ReefFederationProposalResolution,
  ReefGrantAuthority,
} from "./federation-state.js";
import { sameReefPeerIdentity, type ReefPeerIdentity } from "./friend-types.js";

const REEF_FEDERATION_APPROVAL_TIMEOUT_MS = 10 * 60_000;

type ProposalClaim = ReturnType<FederationState["claimProposal"]>;

type FederationState = {
  getMount(mountId: string): ReefFederationMount | undefined;
  authorizeMount(params: ReefGrantAuthority): ReefFederationMount | undefined;
  allowAlways(params: ReefGrantAuthority): boolean;
  claimProposal(proposal: ReefFederationProposal): {
    result: "new" | "duplicate" | "mismatch" | "peer-capacity";
    proposal: ReefFederationProposal;
  };
  resolveProposal(
    proposalId: string,
    digest: string,
    outcome: ReefFederationProposalResolution,
  ): ReefFederationProposal | undefined;
};

type ApprovalResponse = {
  id?: string;
  decision?: "allow-once" | "allow-always" | "deny" | null;
};

type AgentResponse = {
  runId?: string;
};

/** Home-Gateway coordinator for exact, host-approved remote prompt proposals. */
export class ReefFederationCoordinator {
  constructor(
    private readonly runtime: Pick<PluginRuntime, "gateway">,
    private readonly state: FederationState,
    private readonly currentPeerIdentity: (peer: string) => ReefPeerIdentity | undefined,
    private readonly authoritySignal: AbortSignal,
  ) {}

  /** Durably claim one prompt before its transport envelope is acknowledged. */
  claimPrompt(params: {
    from: string;
    to: string;
    peer: string;
    peerIdentity: ReefPeerIdentity;
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>;
  }): ProposalClaim {
    return this.state.claimProposal({
      proposalId: params.frame.proposalId,
      mountId: params.frame.mountId,
      digest: params.frame.textSha256,
      status: "pending",
      request: structuredClone(params),
    });
  }

  /** Validate, approve, and dispatch one remote prompt through canonical agent admission. */
  async handlePrompt(
    params: {
      from: string;
      to: string;
      peer: string;
      peerIdentity: ReefPeerIdentity;
      frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>;
    },
    claim = this.claimPrompt(params),
  ): Promise<Exclude<ReefFederationFrame, { type: "session.prompt.propose" }>> {
    const { frame } = params;
    // Claim before any asynchronous work or authority rejection so every terminal result can be
    // recovered after the source envelope is acknowledged.
    const digest = frame.textSha256;
    if (claim.result === "mismatch") {
      return this.recordFailure(
        frame,
        digest,
        "proposal-rebound",
        "The proposal ID is already bound to other content.",
      );
    }
    if (claim.result === "peer-capacity") {
      return this.failed(
        frame,
        "peer-capacity",
        `Reef peer @${params.peer} exceeded retained prompt capacity.`,
      );
    }
    const prior = priorOutcome(claim.proposal);
    if (prior) {
      return prior;
    }

    const storedMount = this.state.getMount(frame.mountId);
    const mount = this.state.authorizeMount({
      mountId: frame.mountId,
      peer: params.peer,
      peerIdentity: params.peerIdentity,
      sessionId: frame.sessionId,
      generation: frame.grantGeneration,
    });
    const invalid = mount ? undefined : this.validateMount({ ...params, mount: storedMount });
    if (invalid) {
      return this.recordDenial(frame, digest, invalid);
    }
    const expectedDigest = createReefFederatedPromptDigest({
      from: params.from,
      to: params.to,
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      grantGeneration: frame.grantGeneration,
      text: frame.text,
    });
    if (expectedDigest !== digest) {
      return this.recordFailure(
        frame,
        digest,
        "digest-mismatch",
        "The prompt digest does not match its binding.",
      );
    }

    let approvalId = claim.proposal.approvalId;
    if (!mount!.allowAlways && claim.proposal.approvalDecision !== "allow-once") {
      const approval = await this.requestApproval(params.peer, mount!, frame);
      approvalId = approval.id;
      if (approval.decision === "deny") {
        return this.recordDenial(frame, digest, "host-denied", approvalId);
      }
      if (approval.decision !== "allow-once" && approval.decision !== "allow-always") {
        return this.recordFailure(
          frame,
          digest,
          "approval-unavailable",
          "No host approval route accepted the prompt.",
          approvalId,
        );
      }
      if (approval.decision === "allow-once") {
        const recorded = this.state.resolveProposal(frame.proposalId, digest, {
          status: "pending",
          approvalId,
          approvalDecision: "allow-once",
        });
        if (!recorded) {
          throw new Error("Reef could not persist prompt approval before agent admission");
        }
      }
      if (approval.decision === "allow-always") {
        const grantPeerIdentity = this.currentPeerIdentity(params.peer);
        if (!grantPeerIdentity) {
          return this.recordDenial(frame, digest, "grant-revoked", approvalId);
        }
        const grantAuthority = this.state.authorizeMount({
          mountId: frame.mountId,
          peer: params.peer,
          peerIdentity: grantPeerIdentity,
          sessionId: frame.sessionId,
          generation: frame.grantGeneration,
        });
        // Core revalidates the exact grant and lifecycle after awaited approval work and again in
        // the synchronous standing-grant write, preventing a closed Reef lifecycle from persisting.
        if (!grantAuthority) {
          return this.recordDenial(frame, digest, "grant-revoked", approvalId);
        }
        if (
          !this.state.allowAlways({
            mountId: frame.mountId,
            peer: params.peer,
            peerIdentity: grantPeerIdentity,
            sessionId: frame.sessionId,
            generation: frame.grantGeneration,
          })
        ) {
          return this.recordFailure(
            frame,
            digest,
            "grant-stale",
            "The session grant changed before it could be stored.",
            approvalId,
          );
        }
      }
    }

    const currentPeerIdentity = this.currentPeerIdentity(params.peer);
    const currentMount = currentPeerIdentity
      ? this.state.authorizeMount({
          mountId: frame.mountId,
          peer: params.peer,
          peerIdentity: currentPeerIdentity,
          sessionId: frame.sessionId,
          generation: frame.grantGeneration,
        })
      : undefined;
    if (!currentMount) {
      return this.recordDenial(frame, digest, "grant-revoked", approvalId);
    }

    try {
      const idempotencyKey = `reef:${frame.proposalId}`;
      // Canonical agent admission converts inter-session provenance into the model-facing safety
      // envelope. Keep the message undecorated so transcript and display projection remain canonical.
      const result = await this.runtime.gateway.request<AgentResponse>(
        "agent",
        {
          message: frame.text,
          sessionKey: currentMount!.sessionKey,
          expectedExistingSessionId: currentMount!.sessionId,
          idempotencyKey,
          deliver: false,
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: `reef:${params.peer}:${frame.mountId}`,
            sourceChannel: "reef",
            sourceTool: "reef_federated_prompt",
          },
        },
        // Agent admission is in-process and returns on acceptance. Avoid a separate deadline that
        // could report failure after execution started; lifecycle closure aborts and retries by key.
        { signal: this.authoritySignal },
      );
      const accepted = {
        type: "session.prompt.accepted" as const,
        mountId: frame.mountId,
        proposalId: frame.proposalId,
        sessionId: frame.sessionId,
        runId: isProtocolId(result.runId) ? result.runId : frame.proposalId,
      };
      this.state.resolveProposal(frame.proposalId, digest, {
        status: "accepted",
        outcome: accepted,
        ...(approvalId ? { approvalId } : {}),
        runId: accepted.runId,
      });
      return accepted;
    } catch (error) {
      // Lifecycle cancellation can race accepted agent admission. Leave the durable proposal pending
      // so recovery reconciles the same idempotency key instead of publishing a false failure.
      this.authoritySignal.throwIfAborted();
      return this.recordFailure(
        frame,
        digest,
        "dispatch-failed",
        error instanceof Error ? error.message : "Prompt dispatch failed.",
        approvalId,
      );
    }
  }

  private validateMount(params: {
    peer: string;
    peerIdentity: ReefPeerIdentity;
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>;
    mount: ReefFederationMount | undefined;
  }): "grant-revoked" | "stale-session" | undefined {
    const { frame, mount } = params;
    if (
      !mount ||
      mount.role !== "host" ||
      mount.revoked ||
      mount.peer !== params.peer ||
      !sameReefPeerIdentity(mount.peerIdentity, params.peerIdentity) ||
      mount.grantGeneration !== frame.grantGeneration
    ) {
      return "grant-revoked";
    }
    if (mount.sessionId !== frame.sessionId) {
      return "stale-session";
    }
    return undefined;
  }

  private async requestApproval(
    peer: string,
    mount: ReefFederationMount,
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
  ): Promise<ApprovalResponse> {
    return await this.runtime.gateway.request<ApprovalResponse>(
      "plugin.approval.request",
      {
        pluginId: "reef",
        title: `Guest prompt from @${peer}`,
        description: frame.text,
        detail: `Session: ${mount.sessionKey}\nRemote peer: @${peer}\nProposal: ${frame.proposalId}`,
        severity: "info",
        sessionKey: mount.sessionKey,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        timeoutMs: REEF_FEDERATION_APPROVAL_TIMEOUT_MS,
      },
      {
        timeoutMs: REEF_FEDERATION_APPROVAL_TIMEOUT_MS,
        signal: this.authoritySignal,
        scopes: ["operator.approvals"],
      },
    );
  }

  private recordFailure(
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
    digest: string,
    code: string,
    message: string,
    approvalId?: string,
  ): Extract<ReefFederationFrame, { type: "session.prompt.failed" }> {
    const failed = this.failed(frame, code, message);
    this.state.resolveProposal(frame.proposalId, digest, {
      status: "failed",
      outcome: failed,
      failureCode: code,
      ...(approvalId ? { approvalId } : {}),
    });
    return failed;
  }

  private recordDenial(
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
    digest: string,
    reason: Extract<ReefFederationFrame, { type: "session.prompt.denied" }>["reason"],
    approvalId?: string,
  ): Extract<ReefFederationFrame, { type: "session.prompt.denied" }> {
    const denied = this.denied(frame, reason);
    this.state.resolveProposal(frame.proposalId, digest, {
      status: "denied",
      outcome: denied,
      ...(approvalId ? { approvalId } : {}),
    });
    return denied;
  }

  private denied(
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
    reason: Extract<ReefFederationFrame, { type: "session.prompt.denied" }>["reason"],
  ): Extract<ReefFederationFrame, { type: "session.prompt.denied" }> {
    return {
      type: "session.prompt.denied",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      reason,
    };
  }

  private failed(
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
    code: string,
    message: string,
  ): Extract<ReefFederationFrame, { type: "session.prompt.failed" }> {
    return {
      type: "session.prompt.failed",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      code,
      message: truncateUtf8Prefix(message, 512) || "Agent admission failed.",
    };
  }
}

function isProtocolId(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value));
}

function priorOutcome(
  proposal: ReefFederationProposal,
):
  | Exclude<ReefFederationFrame, { type: "session.mount.offer" | "session.prompt.propose" }>
  | undefined {
  return proposal.outcome ? structuredClone(proposal.outcome) : undefined;
}
