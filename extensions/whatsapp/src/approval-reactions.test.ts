// Whatsapp tests cover approval reactions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWhatsAppApprovalReactionTargetsForTest,
  maybeResolveWhatsAppApprovalReaction,
  registerWhatsAppApprovalReactionTarget,
  resolveWhatsAppApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import { resolveEquivalentWhatsAppDirectChatJids, type LidLookup } from "./text-runtime.js";

const resolverMocks = vi.hoisted(() => ({
  resolveWhatsAppApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("./approval-resolver.js", () => ({
  resolveWhatsAppApproval: resolverMocks.resolveWhatsAppApproval,
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

function approvalConfig(allowFrom: string[]) {
  return {
    channels: {
      whatsapp: {
        allowFrom,
      },
    },
  };
}

function registerExecApprovalTarget(params: { remoteJid: string; approvalId?: string }): void {
  registerWhatsAppApprovalReactionTarget({
    accountId: "default",
    remoteJid: params.remoteJid,
    messageId: "approval-message",
    approvalId: params.approvalId ?? "exec-direct",
    approvalKind: "exec",
    allowedDecisions: ["allow-once", "deny"],
  });
}

function buildReactionMessage(params: {
  remoteJid: string;
  reactionRemoteJid?: string;
  participant?: string;
  fromMe?: boolean;
  reactionFromMe?: boolean;
}) {
  return {
    key: {
      id: "reaction-message",
      remoteJid: params.remoteJid,
      ...(params?.participant ? { participant: params.participant } : {}),
      fromMe: params.fromMe ?? false,
    },
    message: {
      reactionMessage: {
        text: "👍",
        key: {
          remoteJid: params.reactionRemoteJid ?? params.remoteJid,
          id: "approval-message",
          ...(params.reactionFromMe === undefined ? {} : { fromMe: params.reactionFromMe }),
        },
      },
    },
  } as never;
}

describe("WhatsApp approval reactions", () => {
  beforeEach(() => {
    clearWhatsAppApprovalReactionTargetsForTest();
    resolverMocks.resolveWhatsAppApproval.mockReset();
    resolverMocks.resolveWhatsAppApproval.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("registers reaction state when only allow-always is available", async () => {
    expect(
      registerWhatsAppApprovalReactionTarget({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "msg-allow-always",
        approvalId: "exec-allow-always",
        approvalKind: "exec",
        allowedDecisions: ["allow-always"],
      }),
    ).toEqual({
      approvalId: "exec-allow-always",
      approvalKind: "exec",
      allowedDecisions: ["allow-always"],
    });
    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "msg-allow-always",
        reactionKey: "♾",
      }),
    ).resolves.toEqual({
      approvalId: "exec-allow-always",
      approvalKind: "exec",
      decision: "allow-always",
    });
  });

  it("rejects reaction targets without an explicit approval kind", () => {
    expect(
      registerWhatsAppApprovalReactionTarget({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "msg-missing-kind",
        approvalId: "exec-missing-kind",
        approvalKind: undefined as unknown as "exec",
        allowedDecisions: ["allow-once"],
      }),
    ).toBeNull();
  });

  it("resolves a registered reaction target", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "15551230000@s.whatsapp.net",
      messageId: "msg-1",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
    });

    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "msg-1",
        reactionKey: "👎",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "deny",
    });
  });

  it("authorizes group reactions using the participant, not the group chat", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "120363401234567890@g.us",
      messageId: "approval-message",
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "120363401234567890@g.us",
        participant: "15551230000@s.whatsapp.net",
      }),
      resolveInboundJid: async (jid) =>
        jid === "15551230000@s.whatsapp.net" ? "+15551230000" : null,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
      cfg: approvalConfig(["+15551230000"]),
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("consumes a losing reaction binding and reports the canonical first answer", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "15551230000@s.whatsapp.net",
      messageId: "approval-message",
      approvalId: "plugin:looks-plugin-but-is-exec",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
    });
    resolverMocks.resolveWhatsAppApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const logVerboseMessage = vi.fn();

    await expect(
      maybeResolveWhatsAppApprovalReaction({
        cfg: approvalConfig(["+15551230000"]),
        accountId: "default",
        msg: buildReactionMessage({ remoteJid: "15551230000@s.whatsapp.net" }),
        resolveInboundJid: async () => "+15551230000",
        logVerboseMessage,
      }),
    ).resolves.toBe(true);

    expect(logVerboseMessage).toHaveBeenCalledWith(
      "whatsapp: approval reaction already resolved id=plugin:looks-plugin-but-is-exec sender=+15551230000 status=denied decision=deny",
    );
    expect(
      logVerboseMessage.mock.calls.some(([message]) =>
        String(message).includes("decision=allow-once"),
      ),
    ).toBe(false);
    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "approval-message",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });

  it("authorizes direct self-chat reactions from the account owner", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "276853659042038@lid",
      messageId: "approval-message",
      approvalId: "exec-self",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230001"]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "276853659042038@lid",
        fromMe: true,
        reactionFromMe: true,
      }),
      selfLid: "276853659042038@lid",
      resolveInboundJid: async (jid) => (jid === "276853659042038@lid" ? "+15551230001" : null),
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
      cfg: approvalConfig(["+15551230001"]),
      approvalId: "exec-self",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230001",
      gatewayUrl: undefined,
    });
  });

  it.each([
    {
      name: "stored PN target from outer chat JID",
      storedRemoteJid: "15551230001@s.whatsapp.net",
      eventRemoteJid: "15551230001@s.whatsapp.net",
      reactionRemoteJid: "276853659042038@lid",
      actorId: "+15551230001",
    },
    {
      name: "stored LID target from PN event",
      storedRemoteJid: "276853659042038@lid",
      eventRemoteJid: "15551230001@s.whatsapp.net",
      actorId: "+15551230001",
      lidForPn: "276853659042038@lid",
    },
    {
      name: "stored PN target from LID event",
      storedRemoteJid: "15551230001@s.whatsapp.net",
      eventRemoteJid: "276853659042038@lid",
      actorId: "+15551230001",
      pnForLid: "15551230001:0@s.whatsapp.net",
    },
    {
      name: "stored PN target from device-qualified PN event",
      storedRemoteJid: "15551230001@s.whatsapp.net",
      eventRemoteJid: "15551230001:0@s.whatsapp.net",
      actorId: "+15551230001",
    },
    {
      name: "stored LID target from device-qualified LID event",
      storedRemoteJid: "276853659042038@lid",
      eventRemoteJid: "276853659042038:1@lid",
      actorId: "+15551230001",
    },
  ])("resolves direct approval reactions across PN/LID target drift: $name", async (testCase) => {
    registerExecApprovalTarget({ remoteJid: testCase.storedRemoteJid });
    const lidLookup: LidLookup = {
      getLIDForPN: vi.fn().mockResolvedValue(testCase.lidForPn ?? null),
      getPNForLID: vi.fn().mockResolvedValue(testCase.pnForLid ?? null),
    };

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig([testCase.actorId]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: testCase.eventRemoteJid,
        reactionRemoteJid: testCase.reactionRemoteJid,
      }),
      resolveInboundJid: async (jid) => (jid === testCase.eventRemoteJid ? testCase.actorId : null),
      resolveReactionTargetJids: async (jid) =>
        resolveEquivalentWhatsAppDirectChatJids(jid, { lidLookup }),
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
      cfg: approvalConfig([testCase.actorId]),
      approvalId: "exec-direct",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: testCase.actorId,
      gatewayUrl: undefined,
    });
  });

  it("does not use a group reaction actor as a direct-chat target candidate", async () => {
    registerExecApprovalTarget({ remoteJid: "15551230000@s.whatsapp.net" });
    const lidLookup: LidLookup = {
      getLIDForPN: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net"),
      getPNForLID: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net"),
    };

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "120363401234567890@g.us",
        participant: "15551230000@s.whatsapp.net",
      }),
      resolveInboundJid: async () => "+15551230000",
      resolveReactionTargetJids: async (jid) =>
        resolveEquivalentWhatsAppDirectChatJids(jid, { lidLookup }),
    });

    expect(handled).toBe(false);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("unregisters the matched target candidate when an approval expired", async () => {
    registerExecApprovalTarget({
      remoteJid: "15551230000@s.whatsapp.net",
      approvalId: "exec-expired",
    });
    resolverMocks.resolveWhatsAppApproval.mockRejectedValueOnce(
      new Error("unknown or expired approval id"),
    );
    resolverMocks.isApprovalNotFoundError.mockReturnValue(true);

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({ remoteJid: "276853659042038@lid" }),
      resolveInboundJid: async () => "+15551230000",
      resolveReactionTargetJids: async (jid) =>
        resolveEquivalentWhatsAppDirectChatJids(jid, {
          lidLookup: { getPNForLID: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net") },
        }),
    });

    expect(handled).toBe(true);
    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "approval-message",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });

  it("does not attribute a peer DM fromMe reaction to the peer", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "15551230000@s.whatsapp.net",
      messageId: "approval-message",
      approvalId: "exec-peer",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "15551230000@s.whatsapp.net",
        fromMe: true,
        reactionFromMe: true,
      }),
      selfLid: "276853659042038@lid",
      resolveInboundJid: async (jid) => {
        if (jid === "15551230000@s.whatsapp.net") {
          return "+15551230000";
        }
        if (jid === "276853659042038@lid") {
          return "+15551230001";
        }
        return null;
      },
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("fails closed when a group reaction is missing actor identity", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "120363401234567890@g.us",
      messageId: "approval-message",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({ remoteJid: "120363401234567890@g.us" }),
      resolveInboundJid: async () => null,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("requires explicit approvers for direct approval reactions", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "15551230000@s.whatsapp.net",
      messageId: "approval-message",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: {
        channels: {
          whatsapp: {},
        },
      },
      accountId: "default",
      msg: buildReactionMessage({ remoteJid: "15551230000@s.whatsapp.net" }),
      resolveInboundJid: async () => "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("requires explicit approvers for group approval reactions", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "120363401234567890@g.us",
      messageId: "approval-message",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: {
        channels: {
          whatsapp: {},
        },
      },
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "120363401234567890@g.us",
        participant: "15551230000@s.whatsapp.net",
      }),
      resolveInboundJid: async () => "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });
});
