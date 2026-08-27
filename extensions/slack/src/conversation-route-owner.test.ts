import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectSlackConversationRouteOwner } from "./conversation-route-owner.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

describe("inspectSlackConversationRouteOwner", () => {
  let releaseInstallation: (() => void) | undefined;

  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    releaseInstallation = registerSlackInstallationState("default", "workspace").release;
  });

  afterEach(() => {
    releaseInstallation?.();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("checks the thread before its parent without touching liveness", () => {
    const touch = vi.fn();
    const resolveByConversation = vi.fn((conversation) =>
      conversation.conversationId === "thread-1"
        ? {
            bindingId: "binding-thread",
            targetSessionKey: "agent:finance:bound",
            targetKind: "session" as const,
            conversation,
            status: "active" as const,
            boundAt: 1,
          }
        : null,
    );
    registerSessionBindingAdapter({
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
      touch,
    });

    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "channel-1", threadId: "thread-1" },
      }),
    ).toEqual({
      kind: "agent",
      agentId: "finance",
      sessionKey: "agent:finance:bound",
    });
    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "channel-1",
    });
    expect(touch).not.toHaveBeenCalled();
  });

  it("distinguishes degraded identity from a qualified target conflict", () => {
    releaseInstallation?.();
    const installation = registerSlackInstallationState("default", "degraded");
    releaseInstallation = installation.release;

    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "C456" },
      }),
    ).toEqual({ kind: "unavailable" });
    installation.update("workspace");
    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "team:T123:channel:C456" },
      }),
    ).toBeNull();
  });

  it("fails closed when workspace identity is released during binding inspection", () => {
    registerSessionBindingAdapter({
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-channel",
        targetSessionKey: "agent:finance:bound",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
      }),
    });
    const input = {
      cfg: {},
      accountId: "default",
      conversation: { kind: "channel" as const, peerId: "C456" },
    };

    expect(inspectSlackConversationRouteOwner(input)).toEqual({
      kind: "agent",
      agentId: "finance",
      sessionKey: "agent:finance:bound",
    });
    releaseInstallation?.();
    releaseInstallation = undefined;
    expect(inspectSlackConversationRouteOwner(input)).toEqual({ kind: "unavailable" });
  });

  it("preserves the Enterprise workspace partition for a main DM", () => {
    releaseInstallation?.();
    const installation = registerSlackInstallationState("default", "enterprise");
    releaseInstallation = installation.release;

    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: {
          kind: "direct",
          peerId: "team:T123:user:U12345678",
          context: { teamId: "T123" },
        },
      }),
    ).toEqual({
      kind: "agent",
      agentId: "main",
      sessionKey: "agent:main:main:account:default:team:t123",
    });
  });

  it("does not guess whether an unbound DM thread is a session boundary", () => {
    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: {
          kind: "direct",
          peerId: "U12345678",
          threadId: "1710000000.000100",
        },
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });
});
