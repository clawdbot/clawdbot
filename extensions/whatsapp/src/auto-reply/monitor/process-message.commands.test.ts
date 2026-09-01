import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import {
  createTestRegistry,
  setActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "../../channel.js";
import { checkInboundAccessControl } from "../../inbound/access-control.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { buildMentionConfig } from "../mentions.js";
import { applyGroupGating } from "./group-gating.js";
import { processMessage } from "./process-message.js";

describe("WhatsApp command authorization at ordinary DM and mentioned-group dispatch", () => {
  const owner = "+15550001111";
  const self = "+15550009999";
  const member = "+15550002222";
  const groupId = "synthetic-command-group@g.us";
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  const backgroundTasks = new Set<Promise<unknown>>();
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "whatsapp-command-boundary-" });
    cfg = {
      agents: { defaults: { workspace: state.workspaceDir } },
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: [owner],
          groupPolicy: "allowlist",
          groupAllowFrom: [owner, member],
          groups: { [groupId]: { requireMention: true } },
        },
      },
      commands: { bash: true, ownerAllowFrom: [owner] },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: [owner] } } },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin: whatsappPlugin }]),
    );
  });
  afterEach(async () => {
    await Promise.allSettled(backgroundTasks);
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    await state.cleanup();
  });

  async function dispatch(body: string, sender = owner, isGroup = false) {
    const from = isGroup ? groupId : sender;
    const sessionKey = isGroup
      ? "agent:main:whatsapp:group:command-fixture"
      : "agent:main:whatsapp:direct:command-fixture";
    const sendPairing = vi.fn(async () => {
      throw new Error("unexpected pairing send");
    });
    const access = await checkInboundAccessControl({
      cfg,
      accountId: "default",
      from,
      selfE164: self,
      senderE164: sender,
      group: isGroup,
      isFromMe: false,
      remoteJid: isGroup ? groupId : "15550001111@s.whatsapp.net",
      sock: { sendMessage: sendPairing },
    });
    expect(sendPairing).not.toHaveBeenCalled();
    if (!access.allowed) {
      return { admitted: false };
    }
    const msg = createTestWebInboundMessage({
      payload: { body },
      platform: { chatJid: from, recipientJid: self, senderE164: sender, selfE164: self },
      ...(isGroup
        ? {
            group: {
              mentions: {
                jids: body.startsWith("@15550009999") ? ["15550009999@s.whatsapp.net"] : [],
              },
            },
          }
        : {}),
    });
    msg.admission = access.admission;
    const logger = getChildLogger({ module: "whatsapp-command-boundary-test" });
    const groupHistories = new Map();
    const groupMemberNames = new Map();
    if (isGroup) {
      expect(msg.groupMention).toBeUndefined();
      const gate = await applyGroupGating({
        cfg,
        msg,
        agentId: "main",
        sessionKey,
        groupHistoryKey: groupId,
        baseMentionConfig: buildMentionConfig(cfg, "main"),
        groupHistories,
        groupHistoryLimit: 20,
        groupMemberNames,
        logVerbose: vi.fn(),
        replyLogger: logger,
      });
      expect(msg.payload.commandBody ?? msg.payload.body).toBe(body);
      if (!gate.shouldProcess) {
        return { gated: true, groupMention: msg.groupMention };
      }
      expect(msg.groupMention).toEqual({ wasMentioned: true, requireMention: true });
    }
    const buildContext = vi.spyOn(channelInbound, "buildChannelInboundEventContext");
    const decisions: Array<{ finalized: boolean; authorized: boolean; owner: boolean }> = [];
    await processMessage({
      cfg,
      msg,
      route: {
        agentId: "main",
        accountId: "default",
        channel: "whatsapp",
        sessionKey,
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "main",
        matchedBy: "default",
      },
      groupHistoryKey: "command-fixture",
      groupHistories,
      groupMemberNames,
      connectionId: "command-fixture",
      verbose: false,
      maxMediaBytes: 1024,
      backgroundTasks,
      replyLogger: logger,
      buildContext: channelInbound.buildChannelInboundEventContext,
      replyResolver: async () => {
        throw new Error("unexpected model resolver");
      },
      // Stop at dispatch: transport and model execution are outside this producer regression.
      dispatchReplyFromConfig: async ({ ctx }) => {
        const auth = resolveCommandAuthorization({
          ctx,
          cfg,
          commandAuthorized: ctx.CommandAuthorized,
        });
        decisions.push({
          finalized: ctx.CommandAuthorized,
          authorized: auth.isAuthorizedSender,
          owner: auth.senderIsOwner,
        });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    });
    expect(sendPairing).not.toHaveBeenCalled();
    expect(buildContext).toHaveBeenCalledOnce();
    expect(decisions).toHaveLength(1);
    return {
      prepared: buildContext.mock.calls[0]?.[0].access?.commands?.authorized,
      ...decisions[0],
    };
  }

  it.each([
    "! exit 0",
    "!poll",
    "! poll",
    "!stop",
    "! stop",
    "/bash exit 0",
    "/bash poll",
    "/bash stop",
    "!",
    "!: exit 0",
    "! (exit 0)",
    "! 'printf' ok",
    "! ./fixture",
    "! /bin/true",
    "! # comment",
    "! 2>/dev/null",
  ])("carries real owner authorization to dispatch for %s", async (body) => {
    expect(await dispatch(body)).toEqual({
      prepared: true,
      finalized: true,
      authorized: true,
      owner: true,
    });
  });
  it("leaves ordinary text unchecked and default-denied for commands", async () => {
    expect(shouldComputeCommandAuthorized("ordinary text", cfg)).toBe(false);
    expect(await dispatch("ordinary text")).toEqual({
      prepared: undefined,
      finalized: false,
      authorized: false,
      owner: true,
    });
  });
  it.each([true, false])("preserves explicit command allowlist match=%s", async (match) => {
    cfg.commands!.allowFrom = { whatsapp: match ? [owner] : [] };
    expect(await dispatch("! poll")).toMatchObject({ authorized: match, owner: true });
  });
  it("does not grant command authority to a DM admitted by open policy", async () => {
    cfg.channels!.whatsapp!.dmPolicy = "open";
    cfg.channels!.whatsapp!.allowFrom = ["*"];
    expect(await dispatch("! poll", "+15550002222")).toMatchObject({
      prepared: true,
      finalized: true,
      authorized: false,
      owner: false,
    });
  });
  it("preserves explicit owner precedence over channel authorization", async () => {
    cfg.commands!.ownerAllowFrom = ["+15550002222"];
    expect(await dispatch("! poll")).toMatchObject({
      prepared: true,
      finalized: true,
      authorized: false,
      owner: false,
    });
  });
  it("keeps text command authorization on the non-native WhatsApp surface", async () => {
    cfg.commands!.text = false;
    expect(await dispatch("! poll")).toMatchObject({ authorized: true });
  });
  it.each([
    "! exit 0",
    "! poll",
    "! stop",
    "!exit 0",
    "!poll",
    "!stop",
    "/bash exit 0",
    "/bash poll",
    "/bash stop",
    "!",
    "! (exit 0)",
    "! 'printf' ok",
    "! 2>/dev/null",
  ])("carries mentioned-group owner authorization for %s", async (command) => {
    expect(await dispatch(`@15550009999 ${command}`, owner, true)).toEqual({
      prepared: true,
      finalized: true,
      authorized: true,
      owner: true,
    });
  });
  it.each(["! exit 0", "!poll", "! poll", "!stop", "! stop"])(
    "keeps unmentioned group input gated for %s",
    async (body) => {
      expect(await dispatch(body, owner, true)).toEqual({
        gated: true,
        groupMention: { wasMentioned: false, requireMention: true },
      });
    },
  );
  it("keeps a mentioned admitted group member outside explicit owner authority", async () => {
    expect(await dispatch("@15550009999 ! poll", member, true)).toEqual({
      prepared: true,
      finalized: true,
      authorized: false,
      owner: false,
    });
  });
  it("keeps unallowlisted mentioned group senders outside admission", async () => {
    expect(await dispatch("@15550009999 ! poll", "+15550003333", true)).toEqual({
      admitted: false,
    });
  });
  it.each([true, false])(
    "keeps mentioned-group command allowlist match=%s authoritative",
    async (match) => {
      cfg.commands!.allowFrom = { whatsapp: match ? [owner] : [] };
      expect(await dispatch("@15550009999 ! poll", owner, true)).toMatchObject({
        authorized: match,
        owner: true,
      });
    },
  );
});
