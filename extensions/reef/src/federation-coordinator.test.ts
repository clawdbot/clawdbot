import { describe, expect, it, vi } from "vitest";
import {
  createReefFederatedPromptDigest,
  type ReefFederationFrame,
} from "../protocol/federation.js";
import { ReefFederationCoordinator } from "./federation-coordinator.js";
import type {
  ReefFederationMount,
  ReefFederationProposal,
  ReefFederationProposalResolution,
} from "./federation-state.js";
import type { ReefPeerIdentity } from "./friend-types.js";

const from = "guest#1";
const to = "host#1";
const mount: ReefFederationMount = {
  mountId: "mount-1",
  peer: "guest",
  peerIdentity: {
    ed25519PublicKey: "A".repeat(43),
    x25519PublicKey: "B".repeat(43),
    keyEpoch: 1,
  },
  role: "host",
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  grantGeneration: 0,
  allowAlways: false,
  revoked: false,
};

function promptFrame(
  overrides: Partial<Extract<ReefFederationFrame, { type: "session.prompt.propose" }>> = {},
): Extract<ReefFederationFrame, { type: "session.prompt.propose" }> {
  const binding = {
    from,
    to,
    mountId: mount.mountId,
    proposalId: "proposal-1",
    sessionId: mount.sessionId,
    grantGeneration: mount.grantGeneration,
    text: "Check the current build",
    ...overrides,
  };
  return {
    type: "session.prompt.propose",
    mountId: binding.mountId,
    proposalId: binding.proposalId,
    sessionId: binding.sessionId,
    grantGeneration: binding.grantGeneration,
    text: binding.text,
    textSha256: createReefFederatedPromptDigest(binding),
  };
}

function fixture(fixtureOptions?: {
  allowAlways?: boolean;
  role?: ReefFederationMount["role"];
  proposals?: Map<string, ReefFederationProposal>;
}) {
  const authority = new AbortController();
  let currentPeerIdentity = { ...mount.peerIdentity };
  let currentMount = {
    ...mount,
    allowAlways: fixtureOptions?.allowAlways ?? false,
    role: fixtureOptions?.role ?? mount.role,
  };
  const proposals = fixtureOptions?.proposals ?? new Map<string, ReefFederationProposal>();
  const state = {
    getMount: vi.fn(() => ({ ...currentMount })),
    authorizeMount: vi.fn(
      (candidate: {
        mountId: string;
        peer: string;
        peerIdentity: ReefPeerIdentity;
        sessionId: string;
        generation: number;
      }) => {
        if (
          authority.signal.aborted ||
          candidate.mountId !== currentMount.mountId ||
          candidate.peer !== currentMount.peer ||
          candidate.sessionId !== currentMount.sessionId ||
          candidate.generation !== currentMount.grantGeneration ||
          candidate.peerIdentity.ed25519PublicKey !== currentMount.peerIdentity.ed25519PublicKey ||
          candidate.peerIdentity.x25519PublicKey !== currentMount.peerIdentity.x25519PublicKey ||
          candidate.peerIdentity.keyEpoch !== currentMount.peerIdentity.keyEpoch ||
          currentMount.revoked ||
          currentMount.role !== "host"
        ) {
          return undefined;
        }
        return { ...currentMount };
      },
    ),
    allowAlways: vi.fn((candidate: { mountId: string; generation: number }) => {
      if (
        authority.signal.aborted ||
        candidate.mountId !== currentMount.mountId ||
        candidate.generation !== currentMount.grantGeneration
      ) {
        return false;
      }
      currentMount = { ...currentMount, allowAlways: true };
      return true;
    }),
    claimProposal: vi.fn(
      (
        proposal: ReefFederationProposal,
      ): {
        result: "new" | "duplicate" | "mismatch" | "peer-capacity";
        proposal: ReefFederationProposal;
      } => {
        const existing = proposals.get(proposal.proposalId);
        if (!existing) {
          proposals.set(proposal.proposalId, { ...proposal });
          return { result: "new" as const, proposal };
        }
        if (existing.digest !== proposal.digest) {
          proposals.set(`${proposal.proposalId}:${proposal.digest}`, { ...proposal });
          return { result: "mismatch", proposal };
        }
        return { result: "duplicate", proposal: { ...existing } };
      },
    ),
    resolveProposal: vi.fn(
      (proposalId: string, digest: string, outcome: ReefFederationProposalResolution) => {
        const reboundKey = `${proposalId}:${digest}`;
        const key = proposals.has(reboundKey) ? reboundKey : proposalId;
        const existing = proposals.get(key);
        if (!existing || existing.digest !== digest) {
          return undefined;
        }
        const resolved = { ...existing, ...outcome };
        proposals.set(key, resolved);
        return resolved;
      },
    ),
  };
  const request = vi.fn(
    async (
      method: string,
      _params?: Record<string, unknown>,
      _options?: { timeoutMs?: number; signal?: AbortSignal },
    ) =>
      method === "plugin.approval.request"
        ? { id: "plugin:approval-1", decision: "allow-once" }
        : { runId: "run-1" },
  );
  const gatewayRequest = async <T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> => {
    const response = await request(method, params, options);
    // SAFETY: this fixture returns the exact response shape for each method the coordinator calls.
    return response as T;
  };
  const coordinator = new ReefFederationCoordinator(
    { gateway: { isAvailable: async () => true, request: gatewayRequest } },
    state,
    () => ({ ...currentPeerIdentity }),
    authority.signal,
  );
  const updateMount = (patch: Partial<ReefFederationMount>) => {
    currentMount = { ...currentMount, ...patch };
  };
  const updatePeerIdentity = (patch: Partial<ReefPeerIdentity>) => {
    currentPeerIdentity = { ...currentPeerIdentity, ...patch };
  };
  return {
    authority,
    coordinator,
    request,
    state,
    proposals,
    updateMount,
    updatePeerIdentity,
  };
}

async function handle(
  coordinator: ReefFederationCoordinator,
  frame = promptFrame(),
  overrides: Partial<{ peer: string; peerIdentity: ReefPeerIdentity }> = {},
) {
  return await coordinator.handlePrompt({
    from,
    to,
    peer: "guest",
    peerIdentity: mount.peerIdentity,
    frame,
    ...overrides,
  });
}

describe("Reef federation coordinator", () => {
  it("uses lifecycle-bound canonical agent admission without an ambiguous deadline", async () => {
    const { authority, coordinator, request } = fixture();

    await expect(handle(coordinator)).resolves.toMatchObject({
      type: "session.prompt.accepted",
      runId: "run-1",
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "plugin.approval.request",
      expect.objectContaining({
        pluginId: "reef",
        description: "Check the current build",
        sessionKey: mount.sessionKey,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      }),
      {
        timeoutMs: 10 * 60_000,
        signal: authority.signal,
        scopes: ["operator.approvals"],
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({
        expectedExistingSessionId: mount.sessionId,
        idempotencyKey: "reef:proposal-1",
        inputProvenance: expect.objectContaining({
          kind: "inter_session",
          sourceChannel: "reef",
          sourceTool: "reef_federated_prompt",
        }),
      }),
      { signal: authority.signal },
    );
  });

  it("stores allow-always and skips approval for the next exact proposal", async () => {
    const { coordinator, request, state } = fixture();
    request.mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-always" });

    await handle(coordinator);
    await handle(coordinator, promptFrame({ proposalId: "proposal-2" }));

    expect(state.allowAlways).toHaveBeenCalledWith(
      expect.objectContaining({ mountId: mount.mountId, generation: 0 }),
    );
    expect(
      request.mock.calls.filter(([method]) => method === "plugin.approval.request"),
    ).toHaveLength(1);
  });

  it("records denial without dispatching an agent run", async () => {
    const { coordinator, request } = fixture();
    request.mockResolvedValueOnce({ id: "plugin:approval-1", decision: "deny" });

    await expect(handle(coordinator)).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "host-denied",
    });
    expect(request.mock.calls.some(([method]) => method === "agent")).toBe(false);
  });

  it("persists stale grant and session denials before approval", async () => {
    const { coordinator, proposals, request } = fixture();

    await expect(handle(coordinator, promptFrame({ grantGeneration: 1 }))).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "grant-revoked",
    });
    await expect(
      handle(coordinator, promptFrame({ proposalId: "proposal-2", sessionId: "session-2" })),
    ).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "stale-session",
    });
    expect(request).not.toHaveBeenCalled();
    expect([...proposals.values()]).toEqual([
      expect.objectContaining({
        status: "denied",
        outcome: expect.objectContaining({ reason: "grant-revoked" }),
      }),
      expect.objectContaining({
        status: "denied",
        outcome: expect.objectContaining({ reason: "stale-session" }),
      }),
    ]);
  });

  it("persists digest rejection before returning its terminal outcome", async () => {
    const { coordinator, proposals, request } = fixture();
    const frame = { ...promptFrame(), textSha256: "f".repeat(64) };

    await expect(handle(coordinator, frame)).resolves.toMatchObject({
      type: "session.prompt.failed",
      code: "digest-mismatch",
    });
    expect(proposals.get(frame.proposalId)).toMatchObject({
      digest: frame.textSha256,
      status: "failed",
      outcome: { type: "session.prompt.failed", code: "digest-mismatch" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("persists a rebound failure independently from the original proposal", async () => {
    const { coordinator, proposals, request } = fixture();
    await handle(coordinator);
    const rebound = promptFrame({ text: "Different content" });

    await expect(handle(coordinator, rebound)).resolves.toMatchObject({
      type: "session.prompt.failed",
      code: "proposal-rebound",
    });
    expect(proposals.get(`${rebound.proposalId}:${rebound.textSha256}`)).toMatchObject({
      digest: rebound.textSha256,
      status: "failed",
      outcome: { type: "session.prompt.failed", code: "proposal-rebound" },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses a protocol-valid fallback when agent admission omits a run ID", async () => {
    const { coordinator, request } = fixture({ allowAlways: true });
    const proposalId = `p${"x".repeat(127)}`;
    request.mockResolvedValueOnce({ runId: "" });

    await expect(handle(coordinator, promptFrame({ proposalId }))).resolves.toMatchObject({
      type: "session.prompt.accepted",
      runId: proposalId,
    });
  });

  it("bounds dispatch failures by UTF-8 bytes", async () => {
    const { coordinator, proposals, request } = fixture({ allowAlways: true });
    request.mockRejectedValueOnce(new Error("🦞".repeat(512)));

    const outcome = await handle(coordinator);

    expect(outcome).toMatchObject({ type: "session.prompt.failed", code: "dispatch-failed" });
    if (outcome.type !== "session.prompt.failed") {
      throw new Error("expected failed prompt outcome");
    }
    expect(Buffer.byteLength(outcome.message, "utf8")).toBe(512);
    expect(proposals.get("proposal-1")?.outcome).toEqual(outcome);
  });

  it("persists a protocol-valid fallback for an empty dispatch error", async () => {
    const { coordinator, proposals, request } = fixture({ allowAlways: true });
    request.mockRejectedValueOnce(new Error());

    const outcome = await handle(coordinator);

    expect(outcome).toMatchObject({
      type: "session.prompt.failed",
      code: "dispatch-failed",
      message: "Agent admission failed.",
    });
    expect(proposals.get("proposal-1")?.outcome).toEqual(outcome);
  });

  it("revalidates grant and peer authority after host approval", async () => {
    const revoked = fixture();
    revoked.request.mockImplementationOnce(async () => {
      revoked.updateMount({ grantGeneration: 1 });
      return { id: "plugin:approval-1", decision: "allow-once" };
    });
    await expect(handle(revoked.coordinator)).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "grant-revoked",
    });
    expect(revoked.request.mock.calls.some(([method]) => method === "agent")).toBe(false);

    const rotated = fixture();
    rotated.request.mockImplementationOnce(async () => {
      rotated.updatePeerIdentity({ ed25519PublicKey: "C".repeat(43) });
      return { id: "plugin:approval-2", decision: "allow-once" };
    });
    await expect(handle(rotated.coordinator)).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "grant-revoked",
    });
    expect(rotated.request.mock.calls.some(([method]) => method === "agent")).toBe(false);
  });

  it("rejects an approved prompt when its Reef lifecycle closes", async () => {
    const stopped = fixture();
    stopped.request.mockImplementationOnce(async () => {
      stopped.authority.abort();
      return { id: "plugin:approval-1", decision: "allow-once" };
    });

    await expect(handle(stopped.coordinator)).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "grant-revoked",
    });
    expect(stopped.request.mock.calls.some(([method]) => method === "agent")).toBe(false);
  });

  it("does not persist allow-always after its Reef lifecycle closes", async () => {
    const stopped = fixture();
    stopped.request.mockImplementationOnce(async () => {
      stopped.authority.abort();
      return { id: "plugin:approval-1", decision: "allow-always" };
    });

    await expect(handle(stopped.coordinator)).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "grant-revoked",
    });
    expect(stopped.state.allowAlways).not.toHaveBeenCalled();
    expect(stopped.request.mock.calls.some(([method]) => method === "agent")).toBe(false);
  });

  it("cancels a pending approval with the Reef lifecycle without committing an outcome", async () => {
    const stopped = fixture();
    stopped.request.mockImplementationOnce(
      async (_method, _params, options?: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                options.signal?.reason instanceof Error
                  ? options.signal.reason
                  : new Error("Reef lifecycle ended"),
              ),
            { once: true },
          );
        }),
    );

    const pending = handle(stopped.coordinator);
    await vi.waitFor(() => expect(stopped.request).toHaveBeenCalledTimes(1));
    stopped.authority.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.proposals.get("proposal-1")).toMatchObject({ status: "pending" });
    expect(stopped.proposals.get("proposal-1")?.outcome).toBeUndefined();
  });

  it("leaves an ambiguous agent abort pending for idempotent lifecycle recovery", async () => {
    const stopped = fixture();
    stopped.request
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" })
      .mockImplementationOnce(async () => {
        stopped.authority.abort();
        throw new Error("agent admission interrupted");
      });

    await expect(handle(stopped.coordinator)).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.proposals.get("proposal-1")).toMatchObject({
      status: "pending",
      approvalId: "plugin:approval-1",
      approvalDecision: "allow-once",
    });
    expect(stopped.proposals.get("proposal-1")?.outcome).toBeUndefined();

    const replacement = fixture({ proposals: stopped.proposals });
    await expect(handle(replacement.coordinator)).resolves.toMatchObject({
      type: "session.prompt.accepted",
      runId: "run-1",
    });
    expect(replacement.request.mock.calls.map(([method]) => method)).toEqual(["agent"]);
    expect(replacement.request).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ idempotencyKey: "reef:proposal-1" }),
      { signal: replacement.authority.signal },
    );
  });

  it("rejects a peer at retained-proposal capacity before authority or agent work", async () => {
    const bounded = fixture();
    bounded.state.claimProposal.mockImplementationOnce((proposal) => ({
      result: "peer-capacity",
      proposal,
    }));

    await expect(handle(bounded.coordinator)).resolves.toMatchObject({
      type: "session.prompt.failed",
      code: "peer-capacity",
      message: "Reef peer @guest exceeded retained prompt capacity.",
    });
    expect(bounded.state.getMount).not.toHaveBeenCalled();
    expect(bounded.request).not.toHaveBeenCalled();
  });

  it("rejects a guest-side mount offered back to the host", async () => {
    const { coordinator, request } = fixture({ role: "guest" });

    await expect(handle(coordinator)).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "grant-revoked",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns a committed duplicate outcome without another run", async () => {
    const { coordinator, request } = fixture({ allowAlways: true });

    const first = await handle(coordinator);
    const second = await handle(coordinator);

    expect(second).toEqual(first);
    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(1);
  });
});
