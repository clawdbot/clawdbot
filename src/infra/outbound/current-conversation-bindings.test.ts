// Verifies generic current-conversation binding persistence, TTL pruning,
// capability discovery, touch, list, and unbind behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import {
  testing,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  listGenericCurrentConversationBindingsBySession,
  resolveGenericCurrentConversationBinding,
  touchGenericCurrentConversationBinding,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

type CurrentConversationBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

function expectSessionBinding(bound: SessionBindingRecord | null): SessionBindingRecord {
  if (bound === null) {
    throw new Error("Expected current-conversation binding");
  }
  return bound;
}

function expectBindingFields(
  binding: SessionBindingRecord | null | undefined,
  expected: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  const record = expectSessionBinding(binding ?? null);
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key as keyof SessionBindingRecord]).toEqual(value);
  }
  return record;
}

function expectBindingMetadata(
  binding: SessionBindingRecord | null | undefined,
  expected: Record<string, unknown>,
): void {
  const metadata = expectSessionBinding(binding ?? null).metadata;
  for (const [key, value] of Object.entries(expected)) {
    expect(metadata?.[key]).toEqual(value);
  }
}

function buildConversationKey(ref: SessionBindingRecord["conversation"]): string {
  return [ref.channel, ref.accountId, ref.parentConversationId ?? "", ref.conversationId].join(
    "\u241f",
  );
}

function seedPersistedBinding(record: SessionBindingRecord): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
    executeSqliteQuerySync(
      db,
      bindingDb.insertInto("current_conversation_bindings").values({
        binding_key: buildConversationKey(record.conversation),
        binding_id: record.bindingId,
        target_agent_id: "codex",
        target_session_id: null,
        target_session_key: record.targetSessionKey,
        channel: record.conversation.channel,
        account_id: record.conversation.accountId,
        conversation_kind: "current",
        parent_conversation_id: record.conversation.parentConversationId ?? null,
        conversation_id: record.conversation.conversationId,
        target_kind: record.targetKind,
        status: record.status,
        bound_at: record.boundAt,
        expires_at: record.expiresAt ?? null,
        metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
        record_json: JSON.stringify(record),
        updated_at: record.boundAt,
      }),
    );
  });
}

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "workspace",
        source: "test",
        plugin: {
          id: "workspace",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
      {
        pluginId: "forum",
        source: "test",
        plugin: {
          id: "forum",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
      {
        pluginId: "googlechat",
        source: "test",
        plugin: {
          id: "googlechat",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
    ]),
  );
}

async function withReadOnlyStateDatabase<T>(run: () => T | Promise<T>): Promise<T> {
  const { db } = openOpenClawStateDatabase();
  db.exec("PRAGMA query_only = ON");
  try {
    return await run();
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
}

function workspaceConversation(conversationId: string) {
  return {
    channel: "workspace",
    accountId: "default",
    conversationId,
  };
}

async function bindWorkspaceConversation(
  conversationId: string,
  options: {
    targetSessionKey?: string;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<SessionBindingRecord | null> {
  return bindGenericCurrentConversation({
    targetSessionKey: options.targetSessionKey ?? "agent:codex:acp:workspace-dm",
    targetKind: "session",
    conversation: workspaceConversation(conversationId),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  });
}

function resolveWorkspaceConversation(conversationId: string): SessionBindingRecord | null {
  return resolveGenericCurrentConversationBinding(workspaceConversation(conversationId));
}

describe("generic current-conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    setMinimalCurrentConversationRegistry();
    testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
    closeOpenClawStateDatabaseForTest();
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
        channel: "workspace",
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
        channel: "workspace",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("stores Control UI session-key conversations without a channel plugin", async () => {
    setActivePluginRegistry(createTestRegistry([]));
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "webchat",
        accountId: "default",
      }),
    ).toMatchObject({ bindSupported: true, placements: ["current"] });

    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:adopted",
      targetKind: "session",
      conversation: {
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      },
      metadata: { pluginBindingOwner: "plugin", pluginId: "codex", pluginRoot: "/codex" },
    });

    expectBindingFields(bound, {
      targetSessionKey: "agent:main:adopted",
      conversation: {
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      },
    });
    expectBindingFields(
      resolveGenericCurrentConversationBinding({
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      }),
      { targetSessionKey: "agent:main:adopted" },
    );
  });

  it("reloads persisted bindings after the in-memory cache is cleared", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      metadata: {
        label: "workspace-dm",
      },
    });

    expectBindingFields(bound, {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });

    testing.resetCurrentConversationBindingsForTests();

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expectBindingFields(resolved, {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expectBindingMetadata(resolved, { label: "workspace-dm" });
  });

  it("normalizes persisted target session keys on reload", async () => {
    seedPersistedBinding({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: " agent:codex:acp:workspace-dm ",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      boundAt: 1234,
      metadata: {
        label: "workspace-dm",
      },
    });

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });

    expectBindingFields(resolved, {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expectBindingMetadata(resolved, { label: "workspace-dm" });
    const bindings = listGenericCurrentConversationBindingsBySession(
      "agent:codex:acp:workspace-dm",
    );
    expect(bindings).toHaveLength(1);
    expectBindingFields(bindings[0], {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
  });

  it("drops self-parent conversation refs when storing generic current bindings", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:forum-dm",
      targetKind: "session",
      conversation: {
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
        parentConversationId: "6098642967",
      },
    });

    const boundRecord = expectBindingFields(bound, {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
    });
    expect(boundRecord.conversation).toEqual({
      channel: "forum",
      accountId: "default",
      conversationId: "6098642967",
    });
    expect(bound?.conversation.parentConversationId).toBeUndefined();
    expectBindingFields(
      resolveGenericCurrentConversationBinding({
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
      }),
      {
        bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
        targetSessionKey: "agent:codex:acp:forum-dm",
      },
    );
  });

  it("migrates persisted legacy self-parent binding ids on load", async () => {
    seedPersistedBinding({
      bindingId: "generic:forum\u241fdefault\u241f6098642967\u241f6098642967",
      targetSessionKey: "agent:codex:acp:forum-dm",
      targetKind: "session",
      conversation: {
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
        parentConversationId: "6098642967",
      },
      status: "active",
      boundAt: 1234,
      metadata: {
        label: "forum-dm",
      },
    });

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "forum",
      accountId: "default",
      conversationId: "6098642967",
    });

    const resolvedRecord = expectBindingFields(resolved, {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
      targetSessionKey: "agent:codex:acp:forum-dm",
    });
    expect(resolvedRecord.conversation).toEqual({
      channel: "forum",
      accountId: "default",
      conversationId: "6098642967",
    });
    expect(resolved?.conversation.parentConversationId).toBeUndefined();

    const unbound = await unbindGenericCurrentConversationBindings({
      bindingId: resolved?.bindingId,
      reason: "test cleanup",
    });
    expect(unbound).toHaveLength(1);
    expectBindingFields(unbound[0], {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
    });

    testing.resetCurrentConversationBindingsForTests();
    expect(
      resolveGenericCurrentConversationBinding({
        channel: "forum",
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

    testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      }),
    ).toBeNull();
  });

  it("drops persisted bindings with invalid expiration timestamps", async () => {
    seedPersistedBinding({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      boundAt: 1234,
      expiresAt: 8_640_000_000_000_001,
    });

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toBeNull();
  });

  it("does not bind generic current conversations when ttl expiry overflows", async () => {
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    await expect(
      bindGenericCurrentConversation({
        targetSessionKey: "agent:codex:acp:workspace-dm",
        targetKind: "session",
        conversation: {
          channel: "workspace",
          accountId: "default",
          conversationId: "user:U123",
        },
        ttlMs: 1,
      }),
    ).resolves.toBeNull();
    expect(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toBeNull();
  });

  it("persists touched activity across reloads", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      metadata: {
        label: "workspace-dm",
      },
    });

    expectSessionBinding(bound);

    touchGenericCurrentConversationBinding(
      "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      1_234_567_890,
    );

    testing.resetCurrentConversationBindingsForTests();

    expectBindingMetadata(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
      {
        label: "workspace-dm",
        lastActivityAt: 1_234_567_890,
      },
    );
  });

  describe("SQLite write failures", () => {
    it("keeps a replacement bind out of memory and disk", async () => {
      await bindWorkspaceConversation("user:U1", {
        targetSessionKey: "agent:codex:acp:session-a",
      });

      await expect(
        withReadOnlyStateDatabase(() =>
          bindWorkspaceConversation("user:U1", {
            targetSessionKey: "agent:codex:acp:session-b",
          }),
        ),
      ).rejects.toThrow();

      expect(resolveWorkspaceConversation("user:U1")?.targetSessionKey).toBe(
        "agent:codex:acp:session-a",
      );
      testing.resetCurrentConversationBindingsForTests();
      closeOpenClawStateDatabaseForTest();
      expect(resolveWorkspaceConversation("user:U1")?.targetSessionKey).toBe(
        "agent:codex:acp:session-a",
      );
    });

    it("keeps a failed touch out of memory and disk", async () => {
      const bound = expectSessionBinding(
        await bindWorkspaceConversation("user:U1", { metadata: { label: "workspace-dm" } }),
      );
      const originalActivity = bound.metadata?.lastActivityAt;

      await expect(
        withReadOnlyStateDatabase(() =>
          touchGenericCurrentConversationBinding(bound.bindingId, 9_999_999),
        ),
      ).rejects.toThrow();

      expect(resolveWorkspaceConversation("user:U1")?.metadata?.lastActivityAt).toBe(
        originalActivity,
      );
      testing.resetCurrentConversationBindingsForTests();
      expect(resolveWorkspaceConversation("user:U1")?.metadata?.lastActivityAt).toBe(
        originalActivity,
      );
    });

    it("keeps a binding when unbind by id fails", async () => {
      const bound = expectSessionBinding(await bindWorkspaceConversation("user:U1"));

      await expect(
        withReadOnlyStateDatabase(() =>
          unbindGenericCurrentConversationBindings({
            bindingId: bound.bindingId,
            reason: "test cleanup",
          }),
        ),
      ).rejects.toThrow();

      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
      testing.resetCurrentConversationBindingsForTests();
      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
    });

    it("keeps every matching binding when unbind by session fails", async () => {
      const targetSessionKey = "agent:codex:acp:shared";
      await bindWorkspaceConversation("user:U1", { targetSessionKey });
      await bindWorkspaceConversation("user:U2", { targetSessionKey });

      await expect(
        withReadOnlyStateDatabase(() =>
          unbindGenericCurrentConversationBindings({
            targetSessionKey,
            reason: "test cleanup",
          }),
        ),
      ).rejects.toThrow();

      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
      testing.resetCurrentConversationBindingsForTests();
      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
    });

    it("keeps an expired binding when prune-on-resolve fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      await bindWorkspaceConversation("user:U1", { ttlMs: 1_000 });

      vi.setSystemTime(new Date(1_002_000));
      await expect(
        withReadOnlyStateDatabase(() => resolveWorkspaceConversation("user:U1")),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
      testing.resetCurrentConversationBindingsForTests();
      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
    });

    it("keeps expired list entries when their cleanup write fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      const targetSessionKey = "agent:codex:acp:shared";
      await bindWorkspaceConversation("user:U1", { targetSessionKey });
      await bindWorkspaceConversation("user:U2", { targetSessionKey, ttlMs: 1_000 });

      vi.setSystemTime(new Date(1_002_000));
      await expect(
        withReadOnlyStateDatabase(() =>
          listGenericCurrentConversationBindingsBySession(targetSessionKey),
        ),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
      testing.resetCurrentConversationBindingsForTests();
      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
    });

    it("does not partially prune an unbind-by-session batch", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      const targetSessionKey = "agent:codex:acp:shared";
      await bindWorkspaceConversation("user:U1", { targetSessionKey });
      await bindWorkspaceConversation("user:U2", { targetSessionKey, ttlMs: 1_000 });

      vi.setSystemTime(new Date(1_002_000));
      await expect(
        withReadOnlyStateDatabase(() =>
          unbindGenericCurrentConversationBindings({
            targetSessionKey,
            reason: "test cleanup",
          }),
        ),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
      testing.resetCurrentConversationBindingsForTests();
      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
    });

    it("retries the initial cache load after its SQLite cleanup fails", async () => {
      await bindWorkspaceConversation("user:U1");
      testing.resetCurrentConversationBindingsForTests();

      await expect(
        withReadOnlyStateDatabase(() => resolveWorkspaceConversation("user:U1")),
      ).rejects.toThrow();

      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
    });
  });
});
