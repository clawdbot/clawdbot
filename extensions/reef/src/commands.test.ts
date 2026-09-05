import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mounts = new Map<string, Record<string, unknown>>();
  const federation = {
    createMount: vi.fn((mount: Record<string, unknown>) => {
      mounts.set(String(mount.mountId), mount);
      return true;
    }),
    getMount: vi.fn((mountId: string) => mounts.get(mountId)),
    listMounts: vi.fn(() => [...mounts.values()]),
    authorizeMount: vi.fn(({ mountId }: { mountId: string }) => mounts.get(mountId)),
    acknowledgeRevocation: vi.fn((mountId: string, generation: number) => {
      const mount = mounts.get(mountId);
      if (
        mount?.revoked !== true ||
        mount.revocationPending !== true ||
        mount.grantGeneration !== generation
      ) {
        return false;
      }
      mounts.set(mountId, { ...mount, revocationPending: false });
      return true;
    }),
    revoke: vi.fn((mountId: string, generation: number) => {
      const mount = mounts.get(mountId);
      if (!mount) {
        return undefined;
      }
      if (mount.revoked === true && mount.grantGeneration === generation) {
        return mount;
      }
      const revoked = {
        ...mount,
        allowAlways: false,
        revoked: true,
        revocationPending: true,
        grantGeneration: generation + 1,
      };
      mounts.set(mountId, revoked);
      return revoked;
    }),
  };
  const flow = {
    sendFederation: vi.fn(async () => "envelope-1"),
    proposeFederatedPrompt: vi.fn(async () => "proposal-1"),
  };
  const trust = {
    get: vi.fn(() => ({
      ed25519PublicKey: "A".repeat(43),
      x25519PublicKey: "B".repeat(43),
      keyEpoch: 1,
      safetyNumberChanged: false,
    })),
  };
  const gatewayRequest = vi.fn(async () => ({
    sessions: [{ key: "agent:main:shared", sessionId: "session-1" }],
  }));
  return { mounts, federation, flow, trust, gatewayRequest };
});

vi.mock("./runtime.js", () => ({
  getActiveReef: () => ({
    federation: mocks.federation,
    flow: mocks.flow,
    trust: mocks.trust,
    friends: {},
    reviews: {},
  }),
  getReefRuntime: () => ({ gateway: { request: mocks.gatewayRequest } }),
}));

import { handleReefCommand } from "./commands.js";

describe("Reef session commands", () => {
  beforeEach(() => {
    mocks.mounts.clear();
    vi.clearAllMocks();
  });

  it("shares an exact session incarnation with a trusted peer", async () => {
    const result = await handleReefCommand({
      args: "session share @guest agent:main:shared",
      senderIsOwner: true,
    });

    expect(result.text).toMatch(/^Shared agent:main:shared with @guest as mount reef-mount-/);
    const mount = mocks.federation.createMount.mock.calls[0]![0];
    expect(mount).toMatchObject({
      peer: "guest",
      peerIdentity: expect.objectContaining({ keyEpoch: 1 }),
      role: "host",
      sessionKey: "agent:main:shared",
      sessionId: "session-1",
      grantGeneration: 0,
    });
    expect(mocks.flow.sendFederation).toHaveBeenCalledWith(
      "guest",
      expect.objectContaining({
        type: "session.mount.offer",
        mountId: mount.mountId,
        sessionId: "session-1",
      }),
      { expectedRecipient: mount.peerIdentity },
    );
  });

  it("reports mount quota rejection without sending an offer", async () => {
    mocks.federation.createMount.mockReturnValueOnce(false);

    await expect(
      handleReefCommand({
        args: "session share @guest agent:main:shared",
        senderIsOwner: true,
      }),
    ).resolves.toEqual({
      text: "Could not create a Reef session mount for @guest; retry after older mounts expire.",
    });
    expect(mocks.flow.sendFederation).not.toHaveBeenCalled();
  });

  it("reuses the exact mount when an offer delivery is retried", async () => {
    mocks.flow.sendFederation.mockRejectedValueOnce(new Error("relay unavailable"));

    await expect(
      handleReefCommand({
        args: "session share @guest agent:main:shared",
        senderIsOwner: true,
      }),
    ).rejects.toThrow("relay unavailable");
    const mount = mocks.federation.createMount.mock.calls[0]![0];

    await expect(
      handleReefCommand({
        args: "session share @guest agent:main:shared",
        senderIsOwner: true,
      }),
    ).resolves.toEqual({
      text: `Shared agent:main:shared with @guest as mount ${String(mount.mountId)}.`,
    });
    expect(mocks.federation.createMount).toHaveBeenCalledOnce();
    expect(mocks.flow.sendFederation).toHaveBeenLastCalledWith(
      "guest",
      expect.objectContaining({ mountId: mount.mountId }),
      { expectedRecipient: mount.peerIdentity },
    );
  });

  it("submits and revokes an existing mount", async () => {
    const mount = {
      mountId: "mount-1",
      peer: "host",
      peerIdentity: {
        ed25519PublicKey: "A".repeat(43),
        x25519PublicKey: "B".repeat(43),
        keyEpoch: 1,
      },
      role: "guest",
      sessionKey: "agent:main:shared",
      sessionId: "session-1",
      grantGeneration: 0,
      allowAlways: false,
      revoked: false,
    };
    mocks.mounts.set(mount.mountId, mount);

    await expect(
      handleReefCommand({
        args: "session prompt mount-1 Check the current build",
        senderIsOwner: true,
      }),
    ).resolves.toEqual({ text: "Sent Reef prompt proposal proposal-1." });
    expect(mocks.flow.proposeFederatedPrompt).toHaveBeenCalledWith(
      mount,
      "Check the current build",
      mocks.federation,
    );
    mocks.mounts.set(mount.mountId, { ...mount, role: "host", peer: "host" });

    await expect(
      handleReefCommand({ args: "session revoke mount-1", senderIsOwner: true }),
    ).resolves.toEqual({ text: "Revoked Reef session mount mount-1." });
    expect(mocks.flow.sendFederation).toHaveBeenCalledWith(
      "host",
      {
        type: "session.grant.revoked",
        mountId: "mount-1",
        sessionId: "session-1",
        grantGeneration: 1,
      },
      { expectedRecipient: mount.peerIdentity },
    );
  });

  it("retries delivery of an already committed revocation", async () => {
    const mount = {
      mountId: "mount-1",
      peer: "host",
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
    mocks.mounts.set(mount.mountId, mount);
    mocks.flow.sendFederation.mockRejectedValueOnce(new Error("relay unavailable"));

    await expect(
      handleReefCommand({ args: "session revoke mount-1", senderIsOwner: true }),
    ).rejects.toThrow("relay unavailable");
    await expect(
      handleReefCommand({ args: "session revoke mount-1", senderIsOwner: true }),
    ).resolves.toEqual({ text: "Revoked Reef session mount mount-1." });
    expect(mocks.flow.sendFederation).toHaveBeenLastCalledWith(
      "host",
      {
        type: "session.grant.revoked",
        mountId: "mount-1",
        sessionId: "session-1",
        grantGeneration: 1,
      },
      { expectedRecipient: mount.peerIdentity },
    );
  });

  it("retries an already delivered revocation idempotently", async () => {
    const mount = {
      mountId: "mount-1",
      peer: "host",
      peerIdentity: {
        ed25519PublicKey: "A".repeat(43),
        x25519PublicKey: "B".repeat(43),
        keyEpoch: 1,
      },
      role: "host",
      sessionKey: "agent:main:shared",
      sessionId: "session-1",
      grantGeneration: 1,
      allowAlways: false,
      revoked: true,
      revocationPending: false,
    };
    mocks.mounts.set(mount.mountId, mount);

    await expect(
      handleReefCommand({ args: "session revoke mount-1", senderIsOwner: true }),
    ).resolves.toEqual({ text: "Revoked Reef session mount mount-1." });
    expect(mocks.flow.sendFederation).toHaveBeenCalledOnce();
    expect(mocks.federation.acknowledgeRevocation).not.toHaveBeenCalled();
  });

  it("keeps every session command owner-only", async () => {
    for (const args of ["session list", "session prompt mount-1 hello"]) {
      await expect(handleReefCommand({ args, senderIsOwner: false })).resolves.toEqual({
        text: "Only an owner in commands.ownerAllowFrom can change Reef friends, decide reviews, or share, prompt, and revoke session mounts. Ask a configured owner; friendship changes can also use openclaw reef locally.",
      });
    }
    expect(mocks.federation.listMounts).not.toHaveBeenCalled();
    expect(mocks.flow.proposeFederatedPrompt).not.toHaveBeenCalled();
  });
});
