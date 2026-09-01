// Regression coverage for the plugin SDK session-deletion lifecycle: a
// successful deleteSessionEntry must unbind conversation bindings targeting
// the deleted session, matching the gateway delete path. Without this, a
// stale runtime binding keeps outranking configured ACP routes (issue #115354).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSessionBindingService,
  isSessionBindingPartialCleanupError,
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  deleteSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const tempDirs = createTrackedTempDirs();

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "sdkchat",
        source: "test",
        plugin: {
          id: "sdkchat",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
    ]),
  );
}

describe("session-store-runtime deleteSessionEntry unbinds conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir: string;
  let storePath: string;

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await tempDirs.make("openclaw-sdk-unbind-");
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    storePath = `${testStateDir}/sessions.json`;
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setMinimalCurrentConversationRegistry();
  });

  afterEach(async () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await tempDirs.cleanup();
  });

  async function seedSessionEntry(sessionKey: string, entry: SessionEntry): Promise<void> {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry,
    });
  }

  async function bindConversationToSession(
    sessionKey: string,
    conversationId: string,
  ): Promise<void> {
    await getSessionBindingService().bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: "sdkchat",
        accountId: "acct-1",
        conversationId,
      },
    });
  }

  it("unbinds conversation bindings when the target session is deleted", async () => {
    const sessionKey = "agent:main:acp:live-session";
    await seedSessionEntry(sessionKey, {
      sessionId: "session-live",
      updatedAt: Date.now(),
    });
    await bindConversationToSession(sessionKey, "conv-1");

    expect(getSessionBindingService().listBySession(sessionKey)).toHaveLength(1);
    await expect(deleteSessionEntry({ sessionKey, storePath })).resolves.toBe(true);
    expect(getSessionBindingService().listBySession(sessionKey)).toEqual([]);
  });

  it("keeps bindings when deletion does not remove a session entry", async () => {
    const sessionKey = "agent:main:acp:missing-session";
    await bindConversationToSession(sessionKey, "conv-2");

    await expect(deleteSessionEntry({ sessionKey, storePath })).resolves.toBe(false);
    expect(getSessionBindingService().listBySession(sessionKey)).toHaveLength(1);
  });

  it("keeps unrelated bindings when a session is deleted", async () => {
    const sessionKey = "agent:main:acp:deleted-session";
    const otherSessionKey = "agent:main:acp:other-session";
    await seedSessionEntry(sessionKey, {
      sessionId: "session-deleted",
      updatedAt: Date.now(),
    });
    await bindConversationToSession(sessionKey, "conv-3");
    await bindConversationToSession(otherSessionKey, "conv-4");

    await expect(deleteSessionEntry({ sessionKey, storePath })).resolves.toBe(true);
    expect(getSessionBindingService().listBySession(sessionKey)).toEqual([]);
    expect(getSessionBindingService().listBySession(otherSessionKey)).toHaveLength(1);
  });

  it("converges cleanup and reports partial cleanup when a registered adapter rejects unbind", async () => {
    const sessionKey = "agent:main:acp:adapter-fail-session";
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "sdkchat",
          source: "test",
          plugin: {
            id: "sdkchat",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
            },
          },
        },
        {
          pluginId: "otherchat",
          source: "test",
          plugin: {
            id: "otherchat",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
            },
          },
        },
      ]),
    );
    let adapterBinding: SessionBindingRecord | null = null;
    registerSessionBindingAdapter({
      channel: "sdkchat",
      accountId: "acct-1",
      bind: async (input) => {
        adapterBinding = {
          bindingId: `${input.conversation.accountId}:${input.conversation.conversationId}`,
          targetSessionKey: input.targetSessionKey,
          targetKind: input.targetKind,
          conversation: input.conversation,
          status: "active",
          boundAt: 1,
        };
        return adapterBinding;
      },
      listBySession: (key) => (adapterBinding?.targetSessionKey === key ? [adapterBinding] : []),
      resolveByConversation: () => null,
      unbind: async () => {
        throw new Error("adapter unbind failure");
      },
    });

    await seedSessionEntry(sessionKey, {
      sessionId: "session-adapter-fail",
      updatedAt: Date.now(),
    });
    await getSessionBindingService().bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: { channel: "sdkchat", accountId: "acct-1", conversationId: "conv-adapter" },
    });
    await getSessionBindingService().bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: { channel: "otherchat", accountId: "acct-1", conversationId: "conv-other" },
    });

    expect(getSessionBindingService().listBySession(sessionKey)).toHaveLength(2);
    const deletePromise = deleteSessionEntry({ sessionKey, storePath });
    await expect(deletePromise).rejects.toSatisfy(isSessionBindingPartialCleanupError);
    const error = await deletePromise.catch((err: unknown) => err);
    if (!isSessionBindingPartialCleanupError(error)) {
      throw new Error("expected SessionBindingPartialCleanupError");
    }
    expect(error.removed).toContainEqual(
      expect.objectContaining({
        conversation: { channel: "otherchat", accountId: "acct-1", conversationId: "conv-other" },
      }),
    );
    expect(getSessionBindingService().listBySession(sessionKey)).toHaveLength(1);
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "otherchat",
        accountId: "acct-1",
        conversationId: "conv-other",
      }),
    ).toBeNull();
  });

  it("keeps a same-key successor binding created after the lifecycle fence", async () => {
    const sessionKey = "agent:main:acp:successor-session";
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "sdkchat",
          source: "test",
          plugin: {
            id: "sdkchat",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
            },
          },
        },
        {
          pluginId: "adapterchat",
          source: "test",
          plugin: {
            id: "adapterchat",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
            },
          },
        },
      ]),
    );

    let releaseAdapter: (() => void) | undefined;
    let adapterUnbindStarted = false;
    let adapterBinding: SessionBindingRecord | null = null;
    registerSessionBindingAdapter({
      channel: "adapterchat",
      accountId: "acct-1",
      bind: async (input) => {
        adapterBinding = {
          bindingId: `adapter:${input.conversation.accountId}:${input.conversation.conversationId}`,
          targetSessionKey: input.targetSessionKey,
          targetKind: input.targetKind,
          conversation: input.conversation,
          status: "active",
          boundAt: Date.now(),
        };
        return adapterBinding;
      },
      listBySession: (key) => (adapterBinding?.targetSessionKey === key ? [adapterBinding] : []),
      resolveByConversation: () => null,
      unbind: async () => {
        adapterUnbindStarted = true;
        await new Promise<void>((resolve) => {
          releaseAdapter = resolve;
        });
        const removed = adapterBinding ? [adapterBinding] : [];
        adapterBinding = null;
        return removed;
      },
    });

    await seedSessionEntry(sessionKey, {
      sessionId: "session-original",
      updatedAt: Date.now(),
    });
    await getSessionBindingService().bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: "adapterchat",
        accountId: "acct-1",
        conversationId: "conv-adapter",
      },
    });

    const deletePromise = deleteSessionEntry({ sessionKey, storePath });
    await vi.waitFor(() => {
      if (!adapterUnbindStarted) {
        throw new Error("adapter unbind not started");
      }
    });

    // While the adapter unbind is paused, a same-key successor binds through
    // the generic path. This binding must survive the cleanup fence.
    await getSessionBindingService().bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: "sdkchat",
        accountId: "acct-1",
        conversationId: "conv-successor",
      },
    });

    releaseAdapter?.();
    await expect(deletePromise).resolves.toBe(true);

    const remaining = getSessionBindingService().listBySession(sessionKey);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.conversation.conversationId).toBe("conv-successor");
  });
});
