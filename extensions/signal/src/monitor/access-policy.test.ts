import { describe, expect, it, vi } from "vitest";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>()),
  readStoreAllowFromForDmPolicy: vi.fn(async () => []),
}));

const SIGNAL_GROUP_ID = "signal-group-id";
const OTHER_SIGNAL_GROUP_ID = "other-signal-group-id";
const SIGNAL_SENDER = {
  kind: "phone" as const,
  e164: "+15551230000",
  raw: "+15551230000",
};

async function resolveGroupAccess(params: {
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupId?: string;
}) {
  const access = await resolveSignalAccessState({
    accountId: "default",
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    sender: SIGNAL_SENDER,
    groupId: params.groupId,
  });
  return {
    ...access,
    groupDecision: access.resolveAccessDecision(true),
  };
}

describe("resolveSignalAccessState", () => {
  it("allows group messages when groupAllowFrom contains the inbound Signal group id", async () => {
    const { groupDecision } = await resolveGroupAccess({
      groupAllowFrom: [SIGNAL_GROUP_ID],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(groupDecision.decision).toBe("allow");
  });

  it("allows Signal group target forms in groupAllowFrom", async () => {
    const groupTargetDecision = await resolveGroupAccess({
      groupAllowFrom: [`group:${SIGNAL_GROUP_ID}`],
      groupId: SIGNAL_GROUP_ID,
    });
    const signalGroupTargetDecision = await resolveGroupAccess({
      groupAllowFrom: [`signal:group:${SIGNAL_GROUP_ID}`],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(groupTargetDecision.groupDecision.decision).toBe("allow");
    expect(signalGroupTargetDecision.groupDecision.decision).toBe("allow");
  });

  it("blocks group messages when groupAllowFrom contains a different Signal group id", async () => {
    const { groupDecision } = await resolveGroupAccess({
      groupAllowFrom: [OTHER_SIGNAL_GROUP_ID],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(groupDecision.decision).toBe("block");
  });

  it("keeps sender allowlist compatibility for Signal group messages", async () => {
    const { groupDecision } = await resolveGroupAccess({
      groupAllowFrom: [SIGNAL_SENDER.e164],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(groupDecision.decision).toBe("allow");
  });

  it("does not match group ids against direct-message allowFrom entries", async () => {
    const { dmAccess } = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: [SIGNAL_GROUP_ID],
      groupAllowFrom: [],
      sender: SIGNAL_SENDER,
      groupId: SIGNAL_GROUP_ID,
    });

    expect(dmAccess.decision).toBe("block");
  });

  it("does not let group ids in allowFrom satisfy an explicit groupAllowFrom mismatch", async () => {
    const { groupDecision } = await resolveGroupAccess({
      allowFrom: [SIGNAL_GROUP_ID],
      groupAllowFrom: [OTHER_SIGNAL_GROUP_ID],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(groupDecision.decision).toBe("block");
  });
});

describe("handleSignalDirectMessageAccess", () => {
  it("returns true for already-allowed direct messages", async () => {
    await expect(
      handleSignalDirectMessageAccess({
        dmPolicy: "open",
        dmAccessDecision: "allow",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
        senderDisplay: "Alice",
        accountId: "default",
        sendPairingReply: async () => {},
        log: () => {},
      }),
    ).resolves.toBe(true);
  });

  it("issues a pairing challenge for pairing-gated senders", async () => {
    const replies: string[] = [];
    const sendPairingReply = vi.fn(async (text: string) => {
      replies.push(text);
    });

    await expect(
      handleSignalDirectMessageAccess({
        dmPolicy: "pairing",
        dmAccessDecision: "pairing",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
        senderDisplay: "Alice",
        senderName: "Alice",
        accountId: "default",
        sendPairingReply,
        log: () => {},
      }),
    ).resolves.toBe(false);

    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(replies[0]).toContain("Pairing code:");
  });
});
