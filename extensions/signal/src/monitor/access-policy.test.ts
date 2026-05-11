import type { AccessGroupsConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";

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
  accessGroups?: AccessGroupsConfig;
  storeAllowFrom?: string[];
}) {
  const access = await resolveSignalAccessState({
    accountId: "default",
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    sender: SIGNAL_SENDER,
    groupId: params.groupId,
    isGroup: true,
    cfg: accessGroupsConfig(params.accessGroups),
    readStoreAllowFrom: async () => params.storeAllowFrom ?? [],
  });
  return {
    ...access,
    groupDecision: access.senderAccess,
  };
}

function accessGroupsConfig(
  accessGroups: AccessGroupsConfig | undefined,
): Pick<OpenClawConfig, "accessGroups"> | undefined {
  return accessGroups ? { accessGroups } : undefined;
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

  it("falls back to allowFrom for group sender access when groupAllowFrom is unset", async () => {
    const { groupDecision } = await resolveGroupAccess({
      allowFrom: [SIGNAL_SENDER.e164],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(groupDecision.decision).toBe("allow");
  });

  it("does not match group ids against direct-message allowFrom entries", async () => {
    const { senderAccess } = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: [SIGNAL_GROUP_ID],
      groupAllowFrom: [],
      sender: SIGNAL_SENDER,
      groupId: SIGNAL_GROUP_ID,
      isGroup: false,
    });

    expect(senderAccess.decision).toBe("block");
  });

  it("allows direct messages through static message sender access groups", async () => {
    const { senderAccess } = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: ["accessGroup:operators"],
      groupAllowFrom: [],
      sender: SIGNAL_SENDER,
      isGroup: false,
      cfg: accessGroupsConfig({
        operators: {
          type: "message.senders",
          members: {
            signal: [SIGNAL_SENDER.e164],
          },
        },
      }),
    });

    expect(senderAccess.decision).toBe("allow");
  });

  it("allows group messages through static message sender access groups", async () => {
    const { groupDecision } = await resolveGroupAccess({
      groupAllowFrom: ["accessGroup:operators"],
      groupId: SIGNAL_GROUP_ID,
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            signal: [SIGNAL_SENDER.e164],
          },
        },
      },
    });

    expect(groupDecision.decision).toBe("allow");
  });

  it("preserves matched Signal senders in effective group allowlists", async () => {
    const { groupDecision } = await resolveGroupAccess({
      groupAllowFrom: ["accessGroup:operators"],
      groupId: SIGNAL_GROUP_ID,
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            signal: [SIGNAL_SENDER.e164],
          },
        },
      },
    });

    expect(groupDecision.decision).toBe("allow");
    expect(groupDecision.effectiveGroupAllowFrom).toContain(SIGNAL_SENDER.e164);
  });

  it("allows paired direct senders from the pairing store", async () => {
    const { senderAccess } = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      sender: SIGNAL_SENDER,
      isGroup: false,
      readStoreAllowFrom: async () => [SIGNAL_SENDER.e164],
    });

    expect(senderAccess.decision).toBe("allow");
    expect(senderAccess.effectiveAllowFrom).toEqual([SIGNAL_SENDER.e164]);
  });

  it("does not let pairing-store senders satisfy group access", async () => {
    const { groupDecision } = await resolveGroupAccess({
      groupAllowFrom: [],
      groupId: SIGNAL_GROUP_ID,
      storeAllowFrom: [SIGNAL_SENDER.e164],
    });

    expect(groupDecision.decision).toBe("block");
  });

  it("does not let group ids in allowFrom satisfy an explicit groupAllowFrom mismatch", async () => {
    const { groupDecision } = await resolveGroupAccess({
      allowFrom: [SIGNAL_GROUP_ID],
      groupAllowFrom: [OTHER_SIGNAL_GROUP_ID],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(groupDecision.decision).toBe("block");
  });

  it("keeps sender access allowed while blocking unauthorized group control commands", async () => {
    const access = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "allowlist",
      groupPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      sender: SIGNAL_SENDER,
      groupId: SIGNAL_GROUP_ID,
      isGroup: true,
      hasControlCommand: true,
    });

    expect(access.senderAccess.decision).toBe("allow");
    expect(access.commandAccess).toMatchObject({
      authorized: false,
      shouldBlockControlCommand: true,
    });
  });

  it("authorizes group control commands from the shared ingress command gate", async () => {
    const access = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [SIGNAL_SENDER.e164],
      sender: SIGNAL_SENDER,
      groupId: SIGNAL_GROUP_ID,
      isGroup: true,
      hasControlCommand: true,
    });

    expect(access.commandAccess).toMatchObject({
      authorized: true,
      shouldBlockControlCommand: false,
    });
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
