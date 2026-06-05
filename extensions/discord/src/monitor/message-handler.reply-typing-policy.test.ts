// Discord tests cover message handler.reply typing policy plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { resolveDiscordAcceptedTypingPrestart } from "./message-handler.reply-typing-policy.js";
import { createDiscordPreflightContext } from "./message-handler.test-helpers.js";

function createPolicyContext(
  overrides: Partial<DiscordMessagePreflightContext> = {},
): DiscordMessagePreflightContext {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        enabled: true,
        token: "test-token",
        groupPolicy: "allowlist",
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  return {
    ...createDiscordPreflightContext("c1"),
    cfg,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    discordConfig: cfg.channels?.discord,
    messageText: "hello",
    isDirectMessage: true,
    isGuildMessage: false,
    isGroupDm: false,
    inboundEventKind: "message",
    effectiveWasMentioned: false,
    ...overrides,
  } as DiscordMessagePreflightContext;
}

describe("resolveDiscordAcceptedTypingPrestart", () => {
  it.each([
    ["default direct message", createPolicyContext(), true, "direct"],
    [
      "default mentioned guild message",
      createPolicyContext({
        isDirectMessage: false,
        isGuildMessage: true,
        effectiveWasMentioned: true,
      }),
      true,
      "mentioned-group",
    ],
    [
      "default unmentioned guild message",
      createPolicyContext({
        isDirectMessage: false,
        isGuildMessage: true,
        effectiveWasMentioned: false,
      }),
      false,
      "defer-to-message",
    ],
    [
      "message-tool-only guild message",
      createPolicyContext({
        cfg: {
          ...createPolicyContext().cfg,
          messages: {
            inbound: { debounceMs: 0 },
            groupChat: { visibleReplies: "message_tool" },
          },
        },
        isDirectMessage: false,
        isGuildMessage: true,
        effectiveWasMentioned: false,
      }),
      true,
      "tool-only",
    ],
    [
      "room event",
      createPolicyContext({
        inboundEventKind: "room_event",
      }),
      false,
      "room-event",
    ],
    [
      "configured instant",
      createPolicyContext({
        cfg: {
          ...createPolicyContext().cfg,
          agents: { defaults: { typingMode: "instant" } },
        },
      }),
      true,
      "configured-instant",
    ],
    [
      "configured message",
      createPolicyContext({
        cfg: {
          ...createPolicyContext().cfg,
          agents: { defaults: { typingMode: "message" } },
        },
      }),
      false,
      "configured-not-instant",
    ],
  ] as const)("%s", (_label, ctx, shouldPrestart, reason) => {
    expect(resolveDiscordAcceptedTypingPrestart(ctx)).toMatchObject({
      shouldPrestart,
      reason,
    });
  });
});
