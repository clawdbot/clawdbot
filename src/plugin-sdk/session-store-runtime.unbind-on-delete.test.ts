// Regression coverage for the plugin SDK session-deletion lifecycle: a
// successful deleteSessionEntry must unbind conversation bindings targeting
// the deleted session, matching the gateway delete path. Without this, a
// stale runtime binding keeps outranking configured ACP routes (issue #115354).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
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
});
