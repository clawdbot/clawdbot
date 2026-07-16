// Telegram tests cover telegram reply fence plugin behavior.
import { describe, expect, it } from "vitest";
import { resetTelegramReplyFenceForTest as resetTelegramReplyFenceForTests } from "./runtime.test-support.js";
import {
  beginTelegramReplyFence,
  buildTelegramNonInterruptingReplyFenceKey,
  isTelegramReplyFenceSuperseded,
  releaseTelegramReplyFenceAbortController,
  shouldSupersedeTelegramReplyFence,
  supersedeTelegramReplyFence,
} from "./telegram-reply-fence.js";

describe("shouldSupersedeTelegramReplyFence", () => {
  it("keeps non-interrupting side and status commands from superseding active runs", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/btw what changed?",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/status",
        CommandAuthorized: true,
      }),
    ).toBe(false);
  });

  it("keeps normal turns from superseding while preserving authorized aborts and commands", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "group",
        CommandBody: "@bot answer this",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "group",
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/stop",
        CommandAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/export-trajectory bundle",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
      }),
    ).toBe(true);
  });

  it("keeps normal direct turns deliverable while preserving direct aborts", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "answer this",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/var/log error",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/plugin_command",
        CommandAuthorized: true,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "plugin_command",
          body: "/plugin_command",
        },
      }),
    ).toBe(true);
  });

  it("applies the same supersede rule in groups as in direct chats", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "group",
        CommandBody: "answer this",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "group",
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "group",
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "group",
        CommandBody: "/plugin_command",
        CommandAuthorized: true,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "plugin_command",
          body: "/plugin_command",
        },
      }),
    ).toBe(true);
  });
});

describe("telegram reply fence supersede", () => {
  it("cascades base supersedes to non-interrupting child fences", () => {
    resetTelegramReplyFenceForTests();
    const activeKey = "agent:main:telegram:group:-100123";
    const sideController = new AbortController();
    const mainController = new AbortController();
    beginTelegramReplyFence({
      key: activeKey,
      supersede: true,
      abortController: mainController,
    });
    beginTelegramReplyFence({
      key: buildTelegramNonInterruptingReplyFenceKey({
        activeKey,
        laneKey: "default\0telegram:-100123:btw:100",
      }),
      supersede: false,
      abortController: sideController,
    });

    expect(supersedeTelegramReplyFence(activeKey)).toBe(true);
    expect(mainController.signal.aborted).toBe(true);
    expect(sideController.signal.aborted).toBe(true);
    resetTelegramReplyFenceForTests();
  });

  it("keeps released controllers from being aborted by later fence supersedes", () => {
    resetTelegramReplyFenceForTests();
    const activeKey = "agent:main:telegram:group:-100123";
    const adoptedController = new AbortController();
    const generation = beginTelegramReplyFence({
      key: activeKey,
      supersede: true,
      abortController: adoptedController,
    });
    releaseTelegramReplyFenceAbortController(activeKey, adoptedController);

    // Supersede still bumps generation for delivery staleness, but the released
    // controller is no longer in the fence set so it is not aborted.
    expect(supersedeTelegramReplyFence(activeKey)).toBe(true);
    expect(adoptedController.signal.aborted).toBe(false);
    expect(
      isTelegramReplyFenceSuperseded({
        key: activeKey,
        generation,
      }),
    ).toBe(true);
    resetTelegramReplyFenceForTests();
  });
});
