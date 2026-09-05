import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReefFederationState,
  type ReefFederationMount,
  type ReefFederationProposal,
} from "./federation-state.js";
import {
  createReefFederationTestRuntime,
  resetReefFederationTestRuntime,
} from "./federation-test-runtime.test-support.js";

function createRuntime(stateDir: string) {
  return createReefFederationTestRuntime(stateDir);
}

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

function pendingProposal(overrides: Partial<ReefFederationProposal> = {}): ReefFederationProposal {
  const digest = "a".repeat(64);
  return {
    proposalId: "proposal-1",
    mountId: mount.mountId,
    digest,
    status: "pending",
    request: {
      from: "guest#1",
      to: "host#1",
      peer: "guest",
      peerIdentity: mount.peerIdentity,
      frame: {
        type: "session.prompt.propose",
        mountId: mount.mountId,
        proposalId: "proposal-1",
        sessionId: mount.sessionId,
        grantGeneration: 0,
        text: "Check the build",
        textSha256: digest,
      },
    },
    ...overrides,
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Reef federation state", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    resetReefFederationTestRuntime();
    stateDir = tempDirs.make("openclaw-reef-federation-");
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    resetReefFederationTestRuntime();
  });

  it("persists session-scoped grants and revokes them by generation", () => {
    const state = new ReefFederationState(createRuntime(stateDir), new AbortController().signal);
    expect(state.createMount(mount)).toBe(true);
    expect(
      state.allowAlways({
        mountId: mount.mountId,
        peer: mount.peer,
        peerIdentity: mount.peerIdentity,
        sessionId: mount.sessionId,
        generation: 0,
      }),
    ).toBe(true);
    expect(
      new ReefFederationState(createRuntime(stateDir), new AbortController().signal).getMount(
        mount.mountId,
      ),
    ).toMatchObject({
      allowAlways: true,
      grantGeneration: 0,
      sessionId: mount.sessionId,
    });

    expect(state.revoke(mount.mountId, 0)).toMatchObject({
      allowAlways: false,
      revoked: true,
      grantGeneration: 1,
    });
    expect(state.revoke(mount.mountId, 1)).toMatchObject({
      revoked: true,
      grantGeneration: 1,
    });
    expect(
      state.allowAlways({
        mountId: mount.mountId,
        peer: mount.peer,
        peerIdentity: mount.peerIdentity,
        sessionId: mount.sessionId,
        generation: 0,
      }),
    ).toBe(false);
  });

  it("invalidates persisted grants when the local Reef identity rotates", () => {
    const first = new ReefFederationState(
      createRuntime(stateDir),
      new AbortController().signal,
      "local-key-1",
    );
    expect(first.createMount(mount)).toBe(true);

    const rotated = new ReefFederationState(
      createRuntime(stateDir),
      new AbortController().signal,
      "local-key-2",
    );
    expect(
      rotated.authorizeMount({
        mountId: mount.mountId,
        peer: mount.peer,
        peerIdentity: mount.peerIdentity,
        sessionId: mount.sessionId,
        generation: mount.grantGeneration,
      }),
    ).toBeUndefined();
  });

  it("fails every grant operation closed after the Reef lifecycle ends", () => {
    const authority = new AbortController();
    const state = new ReefFederationState(createRuntime(stateDir), authority.signal);
    expect(state.createMount(mount)).toBe(true);

    authority.abort();

    expect(state.getMount(mount.mountId)).toBeUndefined();
    expect(state.listMounts()).toEqual([]);
    expect(state.createMount({ ...mount, mountId: "closed-mount" })).toBe(false);
    expect(state.revoke(mount.mountId, mount.grantGeneration)).toBeUndefined();
    expect(
      state.authorizeMount({
        mountId: mount.mountId,
        peer: mount.peer,
        peerIdentity: mount.peerIdentity,
        sessionId: mount.sessionId,
        generation: mount.grantGeneration,
      }),
    ).toBeUndefined();
  });

  it("binds incoming revocations to the peer's exact guest mount", () => {
    const state = new ReefFederationState(createRuntime(stateDir), new AbortController().signal);
    expect(state.createMount({ ...mount, role: "guest" })).toBe(true);
    expect(
      state.applyRevocation({
        mountId: mount.mountId,
        peer: "other-peer",
        sessionId: mount.sessionId,
        generation: 3,
        peerIdentity: mount.peerIdentity,
      }),
    ).toBe(false);
    expect(
      state.applyRevocation({
        mountId: mount.mountId,
        peer: mount.peer,
        sessionId: "other-session",
        generation: 3,
        peerIdentity: mount.peerIdentity,
      }),
    ).toBe(false);
    expect(
      state.applyRevocation({
        mountId: mount.mountId,
        peer: mount.peer,
        sessionId: mount.sessionId,
        generation: 3,
        peerIdentity: mount.peerIdentity,
      }),
    ).toBe(true);
    expect(state.getMount(mount.mountId)).toMatchObject({
      allowAlways: false,
      revoked: true,
      grantGeneration: 3,
    });
    expect(
      state.applyRevocation({
        mountId: mount.mountId,
        peer: mount.peer,
        sessionId: mount.sessionId,
        generation: 2,
        peerIdentity: mount.peerIdentity,
      }),
    ).toBe(false);
  });

  it("accepts outbound outcomes only for their exact guest mount and proposal binding", () => {
    const state = new ReefFederationState(createRuntime(stateDir), new AbortController().signal);
    expect(state.createMount({ ...mount, role: "guest" })).toBe(true);
    const request = pendingProposal().request;
    const outcome = {
      type: "session.prompt.accepted" as const,
      mountId: mount.mountId,
      proposalId: request.frame.proposalId,
      sessionId: mount.sessionId,
      runId: "run-1",
    };

    expect(state.registerOutboundProposal(request)).toBe(true);
    expect(state.registerOutboundProposal(request)).toBe(true);
    expect(state.acceptOutboundOutcome("other-peer", mount.peerIdentity, outcome)).toBe("invalid");
    expect(
      state.acceptOutboundOutcome(mount.peer, mount.peerIdentity, {
        ...outcome,
        sessionId: "other-session",
      }),
    ).toBe("invalid");
    expect(state.revoke(mount.mountId, 0)).toBeUndefined();
    expect(
      state.applyRevocation({
        mountId: mount.mountId,
        peer: mount.peer,
        peerIdentity: mount.peerIdentity,
        sessionId: mount.sessionId,
        generation: 1,
      }),
    ).toBe(true);
    expect(state.acceptOutboundOutcome(mount.peer, mount.peerIdentity, outcome)).toBe("accepted");
    expect(state.acceptOutboundOutcome(mount.peer, mount.peerIdentity, outcome)).toBe("duplicate");
  });

  it("finds an unresolved outbound proposal for idempotent command retry", () => {
    const state = new ReefFederationState(createRuntime(stateDir), new AbortController().signal);
    const request = pendingProposal().request;
    expect(state.registerOutboundProposal(request)).toBe(true);
    expect(state.findOutboundProposal({ ...mount, role: "guest" }, request.frame.text)).toEqual(
      request,
    );
  });

  it("deduplicates an exact proposal and rejects ID rebinding", () => {
    const state = new ReefFederationState(createRuntime(stateDir), new AbortController().signal);
    const proposal = pendingProposal();
    const outcome = {
      type: "session.prompt.accepted" as const,
      mountId: mount.mountId,
      proposalId: proposal.proposalId,
      sessionId: mount.sessionId,
      runId: "run-1",
    };

    expect(state.claimProposal(proposal).result).toBe("new");
    expect(state.claimProposal(proposal).result).toBe("duplicate");
    const reboundDigest = "b".repeat(64);
    expect(state.claimProposal({ ...proposal, digest: reboundDigest }).result).toBe("mismatch");
    const reboundOutcome = {
      type: "session.prompt.failed" as const,
      mountId: mount.mountId,
      proposalId: proposal.proposalId,
      sessionId: mount.sessionId,
      code: "proposal-rebound",
      message: "The proposal ID is already bound to other content.",
    };
    expect(
      state.resolveProposal(proposal.proposalId, reboundDigest, {
        status: "failed",
        outcome: reboundOutcome,
      }),
    ).toBeDefined();
    expect(
      state.resolveProposal(proposal.proposalId, proposal.digest, {
        status: "accepted",
        runId: "run-1",
        outcome,
      }),
    ).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(state.listUnsentProposals()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proposalId: proposal.proposalId, outcome }),
        expect.objectContaining({ proposalId: proposal.proposalId, outcome: reboundOutcome }),
      ]),
    );
    expect(state.markOutcomeSent(proposal.proposalId, proposal.digest)).toBe(true);
    expect(state.markOutcomeSent(proposal.proposalId, reboundDigest)).toBe(true);
    expect(state.listUnsentProposals()).toEqual([]);

    const rotatedProposal = pendingProposal({
      proposalId: "proposal-rotated",
      request: {
        ...proposal.request,
        frame: { ...proposal.request.frame, proposalId: "proposal-rotated" },
      },
    });
    const rotatedOutcome = { ...outcome, proposalId: rotatedProposal.proposalId };
    expect(state.claimProposal(rotatedProposal).result).toBe("new");
    expect(
      state.resolveProposal(rotatedProposal.proposalId, rotatedProposal.digest, {
        status: "accepted",
        outcome: rotatedOutcome,
      }),
    ).toBeDefined();
    expect(state.abandonOutcome(rotatedProposal.proposalId, rotatedProposal.digest)).toBe(true);
    expect(state.listUnsentProposals()).toEqual([]);
    expect(state.claimProposal(rotatedProposal).proposal).toMatchObject({
      outcomeAbandonReason: "peer-identity-changed",
    });
  });

  it("bounds retained proposals per peer without blocking duplicates or other peers", () => {
    const state = new ReefFederationState(createRuntime(stateDir), new AbortController().signal);
    const base = pendingProposal();
    for (let index = 0; index < 128; index += 1) {
      const proposalId = `proposal-${index}`;
      expect(
        state.claimProposal(
          pendingProposal({
            proposalId,
            request: {
              ...base.request,
              frame: { ...base.request.frame, proposalId },
            },
          }),
        ).result,
      ).toBe("new");
    }

    const first = pendingProposal({
      proposalId: "proposal-0",
      request: {
        ...base.request,
        frame: { ...base.request.frame, proposalId: "proposal-0" },
      },
    });
    expect(state.claimProposal(first).result).toBe("duplicate");
    expect(state.claimProposal(pendingProposal({ proposalId: "proposal-overflow" })).result).toBe(
      "peer-capacity",
    );
    expect(
      state.claimProposal(
        pendingProposal({
          proposalId: "proposal-other-peer",
          request: {
            ...base.request,
            peer: "other",
            frame: { ...base.request.frame, proposalId: "proposal-other-peer" },
          },
        }),
      ).result,
    ).toBe("new");
  });

  it("returns peer-capacity when other peers fill the durable proposal store", () => {
    const runtime = createRuntime(stateDir);
    const openStore = runtime.state.openSyncKeyedStore;
    const base = pendingProposal();
    const retained = Array.from({ length: 5_000 }, (_, index) => {
      const proposalId = `global-${index}`;
      return {
        key: proposalId,
        value: pendingProposal({
          proposalId,
          request: {
            ...base.request,
            peer: `peer-${Math.floor(index / 127)}`,
            frame: { ...base.request.frame, proposalId },
          },
        }),
        createdAt: index,
      };
    });
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) => {
      const store = openStore<T>(options);
      return options.namespace === "federation-proposals"
        ? { ...store, entries: () => retained as Array<(typeof retained)[number] & { value: T }> }
        : store;
    };
    const state = new ReefFederationState(runtime, new AbortController().signal);

    expect(
      state.claimProposal(
        pendingProposal({
          proposalId: "global-overflow",
          request: {
            ...base.request,
            peer: "peer-below-quota",
            frame: { ...base.request.frame, proposalId: "global-overflow" },
          },
        }),
      ).result,
    ).toBe("peer-capacity");
  });

  it("limits live mounts per peer", () => {
    const state = new ReefFederationState(createRuntime(stateDir), new AbortController().signal);
    for (let index = 0; index < 32; index += 1) {
      expect(
        state.createMount({ ...mount, mountId: `mount-${index}`, sessionId: `session-${index}` }),
      ).toBe(true);
    }
    expect(state.createMount({ ...mount, mountId: "mount-overflow" })).toBe(false);
    expect(state.createMount({ ...mount, mountId: "other-peer", peer: "other" })).toBe(true);
  });
});
