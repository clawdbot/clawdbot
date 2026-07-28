// Qqbot tests cover group gate command-level enforcement.
import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(() => undefined),
  resolveStorePath: vi.fn(() => "/state/agents/default/openclaw-agent.sqlite"),
}));

import type { QQBotInboundAccess } from "../../adapter/index.js";
import type { InboundPipelineDeps } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";
import { runGroupGateStage } from "./group-gate-stage.js";

function buildGroupEvent(content: string): QueuedMessage {
  return {
    type: "group",
    senderId: "U1",
    content,
    messageId: "M1",
    timestamp: "0",
    groupOpenid: "G1",
  };
}

function buildAccess(): QQBotInboundAccess {
  return {
    senderAccess: { decision: "allow" },
    commandAccess: { authorized: true },
  } as unknown as QQBotInboundAccess;
}

function buildDeps(): InboundPipelineDeps {
  return {
    account: {
      accountId: "default",
      appId: "1000000",
      clientSecret: "secret",
      markdownSupport: false,
      config: {},
    },
    cfg: {
      channels: {
        qqbot: {
          appId: "1000000",
          groups: {
            G1: { requireMention: true, commandLevel: "safety" },
          },
        },
      },
    },
    runtime: {} as InboundPipelineDeps["runtime"],
    startTyping: vi.fn(),
    isControlCommand: (content) => content.trim().startsWith("/"),
    adapters: {
      mentionGate: {
        resolveInboundMentionDecision: vi.fn(() => ({
          effectiveWasMentioned: false,
          shouldSkip: true,
          shouldBypassMention: false,
          implicitMention: false,
        })),
      },
    } as unknown as InboundPipelineDeps["adapters"],
  };
}

function setMentionDecision(
  deps: InboundPipelineDeps,
  decision: ReturnType<
    InboundPipelineDeps["adapters"]["mentionGate"]["resolveInboundMentionDecision"]
  >,
): void {
  const mentionGate = deps.adapters.mentionGate as {
    resolveInboundMentionDecision: ReturnType<typeof vi.fn>;
  };
  mentionGate.resolveInboundMentionDecision.mockReturnValue(decision);
}

describe("runGroupGateStage", () => {
  it("surfaces private-only commands before the mention skip hides them", () => {
    const result = runGroupGateStage({
      event: buildGroupEvent("/config: show"),
      deps: buildDeps(),
      accountId: "default",
      sessionKey: "qqbot:group:G1",
      userContent: "/config: show",
      access: buildAccess(),
    });

    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.skipReason).toBe("private_command_only");
    }
  });

  it("classifies mention-stripped private commands", () => {
    const event = buildGroupEvent("<@BOT_OPENID> /config show");
    event.mentions = [
      {
        member_openid: "BOT_OPENID",
        username: "OpenClaw",
      },
    ];

    const result = runGroupGateStage({
      event,
      deps: buildDeps(),
      accountId: "default",
      sessionKey: "qqbot:group:G1",
      userContent: "/config show",
      access: buildAccess(),
    });

    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.skipReason).toBe("private_command_only");
    }
  });

  it("enforces command level from accounts.default group config", () => {
    const deps = buildDeps();
    deps.cfg = {
      channels: {
        qqbot: {
          appId: "1000000",
          groups: {
            G1: { requireMention: true, commandLevel: "all" },
          },
          accounts: {
            default: {
              groups: {
                G1: { requireMention: true, commandLevel: "safety" },
              },
            },
          },
        },
      },
    };

    const result = runGroupGateStage({
      event: buildGroupEvent("/config show"),
      deps,
      accountId: "default",
      sessionKey: "qqbot:group:G1",
      userContent: "/config show",
      access: buildAccess(),
    });

    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.skipReason).toBe("private_command_only");
    }
  });

  it("does not reply to private commands that only mention someone else", () => {
    const deps = buildDeps();
    (
      deps.cfg as { channels: { qqbot: { groups: { G1: { ignoreOtherMentions: boolean } } } } }
    ).channels.qqbot.groups.G1.ignoreOtherMentions = true;
    setMentionDecision(deps, {
      effectiveWasMentioned: false,
      shouldSkip: false,
      shouldBypassMention: false,
      implicitMention: false,
    });
    const event = buildGroupEvent("/config @someone");
    event.mentions = [
      {
        member_openid: "SOMEONE_OPENID",
        username: "Someone",
      },
    ];

    const result = runGroupGateStage({
      event,
      deps,
      accountId: "default",
      sessionKey: "qqbot:group:G1",
      userContent: "/config @Someone",
      access: buildAccess(),
    });

    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.skipReason).toBe("drop_other_mention");
    }
  });

  it("does not reject urgent stop in strict groups", () => {
    const deps = buildDeps();
    (
      deps.cfg as { channels: { qqbot: { groups: { G1: { commandLevel: string } } } } }
    ).channels.qqbot.groups.G1.commandLevel = "strict";
    setMentionDecision(deps, {
      effectiveWasMentioned: true,
      shouldSkip: false,
      shouldBypassMention: true,
      implicitMention: false,
    });

    const result = runGroupGateStage({
      event: buildGroupEvent("/stop"),
      deps,
      accountId: "default",
      sessionKey: "qqbot:group:G1",
      userContent: "/stop",
      access: buildAccess(),
    });

    expect(result.kind).toBe("pass");
  });
});
