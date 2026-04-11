import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  __testing,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  listGenericCurrentConversationBindingsBySession,
  resolveGenericCurrentConversationBinding,
  touchGenericCurrentConversationBinding,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          id: "slack",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
    ]),
  );
}

describe("generic current-conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    setMinimalCurrentConversationRegistry();
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
  });

  afterEach(async () => {
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("advertises support only for channels that opt into current-conversation binds", () => {
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "slack",
        accountId: "default",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "definitely-not-a-channel",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("requires an active channel plugin registration", () => {
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "slack",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("reloads persisted bindings after the in-memory cache is cleared", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:slack-dm",
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
      metadata: {
        label: "slack-dm",
      },
    });

    expect(bound).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:slack-dm",
    });

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:slack-dm",
      metadata: expect.objectContaining({
        label: "slack-dm",
      }),
    });
  });

  it("normalizes persisted target session keys on reload", async () => {
    const filePath = __testing.resolveBindingsFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
            targetSessionKey: " agent:codex:acp:slack-dm ",
            targetKind: "session",
            conversation: {
              channel: "slack",
              accountId: "default",
              conversationId: "user:U123",
            },
            status: "active",
            boundAt: 1234,
            metadata: {
              label: "slack-dm",
            },
          },
        ],
      }),
    );

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    });

    expect(resolved).toMatchObject({
      bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:slack-dm",
      metadata: expect.objectContaining({
        label: "slack-dm",
      }),
    });
    expect(listGenericCurrentConversationBindingsBySession("agent:codex:acp:slack-dm")).toEqual([
      expect.objectContaining({
        bindingId: "generic:slack\u241fdefault\u241f\u241fuser:U123",
        targetSessionKey: "agent:codex:acp:slack-dm",
      }),
    ]);
  });

  it("drops self-parent conversation refs when storing generic current bindings", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:telegram-dm",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "6098642967",
        parentConversationId: "6098642967",
      },
    });

    expect(bound).toMatchObject({
      bindingId: "generic:telegram\u241fdefault\u241f\u241f6098642967",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "6098642967",
      },
    });
    expect(bound?.conversation.parentConversationId).toBeUndefined();
    expect(
      resolveGenericCurrentConversationBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "6098642967",
      }),
    ).toMatchObject({
      bindingId: "generic:telegram\u241fdefault\u241f\u241f6098642967",
      targetSessionKey: "agent:codex:acp:telegram-dm",
    });
  });

  it("migrates persisted legacy self-parent binding ids on load", async () => {
    const filePath = __testing.resolveBindingsFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: "generic:telegram\u241fdefault\u241f6098642967\u241f6098642967",
            targetSessionKey: "agent:codex:acp:telegram-dm",
            targetKind: "session",
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "6098642967",
              parentConversationId: "6098642967",
            },
            status: "active",
            boundAt: 1234,
            metadata: {
              label: "telegram-dm",
            },
          },
        ],
      }),
    );

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "6098642967",
    });

    expect(resolved).toMatchObject({
      bindingId: "generic:telegram\u241fdefault\u241f\u241f6098642967",
      targetSessionKey: "agent:codex:acp:telegram-dm",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "6098642967",
      },
    });
    expect(resolved?.conversation.parentConversationId).toBeUndefined();

    await expect(
      unbindGenericCurrentConversationBindings({
        bindingId: resolved?.bindingId,
        reason: "test cleanup",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingId: "generic:telegram\u241fdefault\u241f\u241f6098642967",
      }),
    ]);

    __testing.resetCurrentConversationBindingsForTests();
    expect(
      resolveGenericCurrentConversationBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "6098642967",
      }),
    ).toBeNull();
  });

  it("removes persisted bindings on unbind", async () => {
    await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:googlechat-room",
      targetKind: "session",
      conversation: {
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      },
    });

    await unbindGenericCurrentConversationBindings({
      targetSessionKey: "agent:codex:acp:googlechat-room",
      reason: "test cleanup",
    });

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      }),
    ).toBeNull();
  });

  it("persists touched activity across reloads", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:slack-dm",
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
      metadata: {
        label: "slack-dm",
      },
    });

    expect(bound).not.toBeNull();

    touchGenericCurrentConversationBinding(
      "generic:slack\u241fdefault\u241f\u241fuser:U123",
      1_234_567_890,
    );

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      })?.metadata,
    ).toEqual(
      expect.objectContaining({
        label: "slack-dm",
        lastActivityAt: 1_234_567_890,
      }),
    );
  });
});
