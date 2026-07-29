// Whatsapp tests cover access control plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AcceptedInboundAccessControlResult } from "./access-control.js";
import {
  readAllowFromStoreMock,
  sendMessageMock,
  getAccessControlTestConfig,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

setupAccessControlTestHarness();
let checkInboundAccessControl: typeof import("./access-control.js").checkInboundAccessControl;
let resolveWhatsAppCommandAuthorized: typeof import("../inbound-policy.js").resolveWhatsAppCommandAuthorized;
type InboundAccessControlResult = Awaited<ReturnType<typeof checkInboundAccessControl>>;

beforeAll(async () => {
  ({ checkInboundAccessControl } = await import("./access-control.js"));
  ({ resolveWhatsAppCommandAuthorized } = await import("../inbound-policy.js"));
});

function expectAccepted(
  result: InboundAccessControlResult,
): asserts result is AcceptedInboundAccessControlResult {
  expect(result.allowed).toBe(true);
  if (!result.allowed) {
    throw new Error("Expected accepted inbound access result");
  }
}

async function checkUnauthorizedWorkDmSender() {
  return checkInboundAccessControl({
    cfg: getAccessControlTestConfig() as never,
    accountId: "work",
    from: "+15550001111",
    selfE164: "+15550009999",
    senderE164: "+15550001111",
    group: false,
    pushName: "Stranger",
    isFromMe: false,
    sock: { sendMessage: sendMessageMock },
    remoteJid: "15550001111@s.whatsapp.net",
  });
}

function expectSilentlyBlocked(result: { allowed: boolean }) {
  expect(result.allowed).toBe(false);
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
}

async function checkCommandAuthorizedForDm(params: {
  cfg: Record<string, unknown>;
  accountId?: string;
  from?: string;
  senderE164?: string;
  selfE164?: string;
}) {
  return await resolveWhatsAppCommandAuthorized({
    cfg: params.cfg as never,
    msg: createTestWebInboundMessage({
      event: { id: "cmd-dm" },
      payload: { body: "/status" },
      platform: {
        chatJid: params.from ?? "+15550001111",
        recipientJid: params.selfE164 ?? "+15550009999",
        senderE164: params.senderE164 ?? params.from ?? "+15550001111",
        selfE164: params.selfE164 ?? "+15550009999",
      },
      admission: {
        accountId: params.accountId ?? "work",
        conversation: {
          kind: "direct",
          id: params.from ?? "+15550001111",
        },
        sender: {
          id: params.senderE164 ?? params.from ?? "+15550001111",
        },
      },
    }) as never,
  });
}

async function checkCommandAuthorizedForGroup(params: {
  cfg: Record<string, unknown>;
  accountId?: string;
  from?: string;
  senderE164?: string;
  selfE164?: string;
}) {
  return await resolveWhatsAppCommandAuthorized({
    cfg: params.cfg as never,
    msg: createTestWebInboundMessage({
      event: { id: "cmd-group" },
      payload: { body: "/status" },
      platform: {
        chatJid: params.from ?? "120363401234567890@g.us",
        recipientJid: params.selfE164 ?? "+15550009999",
        senderE164: params.senderE164 ?? "+15550001111",
        selfE164: params.selfE164 ?? "+15550009999",
      },
      admission: {
        accountId: params.accountId ?? "work",
        conversation: {
          kind: "group",
          id: params.from ?? "120363401234567890@g.us",
        },
        sender: {
          id: params.senderE164 ?? "+15550001111",
        },
        senderAccess: {
          reasonCode: "group_policy_allowed",
        },
      },
    }) as never,
  });
}

describe("checkInboundAccessControl admission contract", () => {
  it("keeps blocked results on the legacy flat access shape", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15559999999"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Stranger",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result).toMatchObject({
      allowed: false,
      shouldMarkRead: false,
      resolvedAccountId: "default",
      isSelfChat: false,
    });
    expect("admission" in result).toBe(false);
  });

  it("returns accepted facts through admission while preserving legacy access fields", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          contextVisibility: "allowlist_quote",
          allowFrom: ["+15550001111"],
          direct: {
            "+15550001111": {
              systemPrompt: "direct prompt",
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expectAccepted(result);
    expect(result.resolvedAccountId).toBe(result.admission.accountId);
    expect(result.isSelfChat).toBe(result.admission.isSelfChat);
    expect(result.shouldMarkRead).toBe(true);
    expect(result.admission).toMatchObject({
      accountId: "default",
      account: {
        accountId: "default",
        enabled: true,
        sendReadReceipts: true,
      },
      conversation: {
        kind: "direct",
        id: "+15550001111",
        groupSessionId: "+15550001111",
      },
      sender: {
        id: "+15550001111",
        isSamePhone: false,
      },
      ingress: {
        admission: "dispatch",
        decision: "allow",
        reasonCode: "activation_allowed",
      },
      senderAccess: {
        allowed: true,
        decision: "allow",
        providerMissingFallbackApplied: false,
        reasonCode: "dm_policy_allowlisted",
      },
      commandAccess: {
        requested: false,
        authorized: false,
        shouldBlockControlCommand: false,
        reasonCode: "command_authorized",
      },
      activationAccess: {
        ran: true,
        allowed: true,
        shouldSkip: false,
        reasonCode: "activation_allowed",
      },
    });
    expect(result.admission.account).not.toHaveProperty("authDir");
    expect(result.admission.conversation).not.toHaveProperty("requireMention");
    expect(result.admission.senderAccess).not.toHaveProperty("effectiveAllowFrom");
    expect(result.admission.senderAccess).not.toHaveProperty("effectiveGroupAllowFrom");
    expect(result.admission).not.toHaveProperty("resolvedPolicy");
  });

  it("uses group participant JID as the admission sender fallback", async () => {
    const groupJid = "120363401234567890@g.us";
    const participantJid = "15550001111@s.whatsapp.net";
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: groupJid,
      selfE164: "+15550009999",
      senderE164: null,
      senderJid: participantJid,
      group: true,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: groupJid,
    });

    expectAccepted(result);
    expect(result.admission.conversation).toMatchObject({
      kind: "group",
      id: groupJid,
      groupSessionId: groupJid,
    });
    expect(result.admission.sender.id).toBe(participantJid);
    expect(result.admission.sender).not.toHaveProperty("dmSenderId");
    expect(result.admission.conversation.kind).toBe("group");
  });

  it("does not authorize unresolved group participant JIDs as phone allowlist entries", async () => {
    const groupJid = "120363401234567890@g.us";
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: groupJid,
      selfE164: "+15550009999",
      senderE164: null,
      senderJid: "15550001111@lid",
      group: true,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: groupJid,
    });

    expect(result.allowed).toBe(false);
    expect("admission" in result).toBe(false);
  });
});

describe("checkInboundAccessControl pairing grace", () => {
  async function runPairingGraceCase(messageTimestampMs: number) {
    const connectedAtMs = 1_000_000;
    return await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      messageTimestampMs,
      connectedAtMs,
      pairingGraceMs: 30_000,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });
  }

  it("suppresses pairing replies for historical DMs on connect", async () => {
    const result = await runPairingGraceCase(1_000_000 - 31_000);

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends pairing replies for live DMs", async () => {
    const result = await runPairingGraceCase(1_000_000 - 10_000);

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
  });
});

describe("WhatsApp dmPolicy precedence", () => {
  it("uses account-level dmPolicy instead of channel-level (#8736)", async () => {
    // Channel-level says "pairing" but the account-level says "allowlist".
    // The account-level override should take precedence, so an unauthorized
    // sender should be blocked silently (no pairing reply).
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          accounts: {
            work: {
              dmPolicy: "allowlist",
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkUnauthorizedWorkDmSender();
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });
    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
  });

  it("inherits channel-level dmPolicy when account-level dmPolicy is unset", async () => {
    // Account has allowFrom set, but no dmPolicy override. Should inherit the channel default.
    // With dmPolicy=allowlist, unauthorized senders are silently blocked.
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkUnauthorizedWorkDmSender();
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });
    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
  });

  it("does not merge persisted pairing approvals in allowlist mode", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);
    readAllowFromStoreMock.mockResolvedValue(["+15550001111"]);

    const result = await checkUnauthorizedWorkDmSender();
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });

    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("always allows same-phone DMs even when allowFrom is restrictive", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+15550001111"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Owner",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550009999@s.whatsapp.net",
    });
    const commandAuthorized = await checkCommandAuthorizedForDm({
      cfg,
      accountId: "default",
      from: "+15550009999",
      senderE164: "+15550009999",
      selfE164: "+15550009999",
    });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("allows DMs from generic message sender access groups", async () => {
    const cfg = {
      accessGroups: {
        owners: {
          type: "message.senders",
          members: {
            whatsapp: ["+15550001111"],
          },
        },
      },
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["accessGroup:owners"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "work",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("allows group messages from generic message sender access groups", async () => {
    const cfg = {
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            whatsapp: ["+15550001111"],
          },
        },
      },
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          groupAllowFrom: ["accessGroup:operators"],
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "work",
      from: "120363401234567890@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "120363401234567890@g.us",
    });
    const commandAuthorized = await checkCommandAuthorizedForGroup({ cfg });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("falls back from empty groupAllowFrom to allowFrom for group allowlists", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          groupAllowFrom: [],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "120363401234567890@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "120363401234567890@g.us",
    });
    const commandAuthorized = await checkCommandAuthorizedForGroup({
      cfg,
      accountId: "default",
    });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does not broaden self-chat mode to every paired DM when allowFrom is empty", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(result.isSelfChat).toBe(false);
  });

  it("authorizes group commands when owner sender is a LID JID with authDir (issue #77755)", async () => {
    const lidDigits = "9876543210";
    const ownerE164 = "+15550001111";
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-77755-"));
    try {
      // Write reverse LID mapping so the LID JID resolves to the owner's phone
      fs.writeFileSync(
        path.join(authDir, `lid-mapping-${lidDigits}_reverse.json`),
        JSON.stringify(ownerE164),
      );

      const cfg = {
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: [ownerE164],
          },
        },
      };
      setAccessControlTestConfig(cfg);

      const result = await resolveWhatsAppCommandAuthorized({
        cfg: cfg as never,
        msg: createTestWebInboundMessage({
          event: { id: "cmd-group-lid" },
          payload: { body: "/status" },
          platform: {
            chatJid: "120363401234567890@g.us",
            recipientJid: "+15550009999",
            senderJid: `${lidDigits}@lid`,
            selfE164: "+15550009999",
          },
          admission: {
            conversation: {
              id: "120363401234567890@g.us",
              kind: "group",
            },
          },
        }) as never,
        authDir,
      });

      expect(result).toBe(true);
    } finally {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("treats same-phone DMs as self-chat only when explicitly configured", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+15550009999"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Owner",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550009999@s.whatsapp.net",
    });

    expect(result.allowed).toBe(true);
    expect(result.isSelfChat).toBe(true);
  });
});
