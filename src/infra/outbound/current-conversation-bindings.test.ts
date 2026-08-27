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

function replacePersistedBinding(record: SessionBindingRecord): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
    executeSqliteQuerySync(
      db,
      bindingDb
        .updateTable("current_conversation_bindings")
        .set({
          binding_id: record.bindingId,
          target_session_key: record.targetSessionKey,
          target_kind: record.targetKind,
          status: record.status,
          bound_at: record.boundAt,
          expires_at: record.expiresAt ?? null,
          metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
          record_json: JSON.stringify(record),
          updated_at: Date.now(),
        })
        .where("binding_key", "=", buildConversationKey(record.conversation)),
    );
  });
}

function readPersistedBinding(conversationId: string): SessionBindingRecord | null {
  const { db } = openOpenClawStateDatabase();
  const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
  const row = executeSqliteQuerySync(
    db,
    bindingDb
      .selectFrom("current_conversation_bindings")
      .select("record_json")
      .where("binding_key", "=", buildConversationKey(workspaceConversation(conversationId))),
  ).rows[0];
  return row ? (JSON.parse(row.record_json) as SessionBindingRecord) : null;
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
    testing.clearPersistedCurrentConversationBindingsForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    testing.clearPersistedCurrentConversationBindingsForTests();
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

  it("preserves persisted bindings after the state database reopens", async () => {
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

    closeOpenClawStateDatabaseForTest();

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

  describe("independent SQLite owners", () => {
    it.each(["bind", "touch", "expiry cleanup", "unbind"] as const)(
      "preserves independently inserted and updated rows during %s",
      async (mutation) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000_000));
        const owned = expectSessionBinding(await bindWorkspaceConversation("user:owner"));
        const previousExternal = expectSessionBinding(
          await bindWorkspaceConversation("user:updated", {
            targetSessionKey: "agent:codex:acp:old-target",
            metadata: { version: "before" },
          }),
        );
        await bindWorkspaceConversation("user:expired", { ttlMs: 1_000 });

        const latestExternal: SessionBindingRecord = {
          ...previousExternal,
          targetSessionKey: "agent:codex:acp:latest-target",
          metadata: { version: "latest", opaque: { nested: true } },
        };
        replacePersistedBinding(latestExternal);
        seedPersistedBinding({
          ...owned,
          bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:inserted",
          targetSessionKey: "agent:codex:acp:inserted-target",
          conversation: workspaceConversation("user:inserted"),
          metadata: { opaque: "external owner" },
        });

        switch (mutation) {
          case "bind":
            await bindWorkspaceConversation("user:replacement");
            break;
          case "touch":
            touchGenericCurrentConversationBinding(owned.bindingId, 1_000_500);
            break;
          case "expiry cleanup":
            vi.setSystemTime(new Date(1_002_000));
            expect(resolveWorkspaceConversation("user:expired")).toBeNull();
            break;
          case "unbind":
            await unbindGenericCurrentConversationBindings({
              bindingId: owned.bindingId,
              reason: "owner cleanup",
            });
            break;
        }

        expectBindingFields(readPersistedBinding("user:inserted"), {
          targetSessionKey: "agent:codex:acp:inserted-target",
        });
        expectBindingFields(readPersistedBinding("user:updated"), {
          targetSessionKey: "agent:codex:acp:latest-target",
        });
        expectBindingMetadata(readPersistedBinding("user:updated"), {
          version: "latest",
          opaque: { nested: true },
        });

        closeOpenClawStateDatabaseForTest();
        expect(resolveWorkspaceConversation("user:inserted")?.targetSessionKey).toBe(
          "agent:codex:acp:inserted-target",
        );
        expect(resolveWorkspaceConversation("user:updated")?.targetSessionKey).toBe(
          "agent:codex:acp:latest-target",
        );
      },
    );

    it("touches the latest committed target and complete opaque metadata", async () => {
      const initial = expectSessionBinding(
        await bindWorkspaceConversation("user:owner", {
          targetSessionKey: "agent:codex:acp:old-target",
          metadata: { stale: true },
        }),
      );
      replacePersistedBinding({
        ...initial,
        targetSessionKey: "agent:codex:acp:latest-target",
        metadata: {
          opaque: { nested: ["latest", { preserved: true }] },
          lastActivityAt: 10,
        },
      });

      touchGenericCurrentConversationBinding(initial.bindingId, 20);

      expectBindingFields(readPersistedBinding("user:owner"), {
        targetSessionKey: "agent:codex:acp:latest-target",
      });
      expectBindingMetadata(readPersistedBinding("user:owner"), {
        opaque: { nested: ["latest", { preserved: true }] },
        lastActivityAt: 20,
      });
      expect(resolveWorkspaceConversation("user:owner")?.targetSessionKey).toBe(
        "agent:codex:acp:latest-target",
      );
    });

    it.each(["rebind", "delete"] as const)(
      "never restores a stale row when another owner commits a %s during normalization",
      (mutation) => {
        const initial: SessionBindingRecord = {
          bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:normalization-race",
          targetSessionKey: " agent:codex:acp:stale-target ",
          targetKind: "session",
          conversation: workspaceConversation("user:normalization-race"),
          status: "active",
          boundAt: 1_000,
          metadata: { version: "stale" },
        };
        seedPersistedBinding(initial);
        const latest: SessionBindingRecord = {
          ...initial,
          targetSessionKey: "agent:codex:acp:latest-target",
          metadata: { version: "latest", opaque: { preserved: true } },
        };
        const parseJson = JSON.parse;
        let committed = false;
        const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          const parsed = parseJson(text, reviver);
          if (!committed && text.includes("user:normalization-race")) {
            committed = true;
            if (mutation === "rebind") {
              replacePersistedBinding(latest);
            } else {
              runOpenClawStateWriteTransaction(({ db }) => {
                const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
                executeSqliteQuerySync(
                  db,
                  bindingDb
                    .deleteFrom("current_conversation_bindings")
                    .where("binding_key", "=", buildConversationKey(initial.conversation)),
                );
              });
            }
          }
          return parsed;
        });

        try {
          const resolved = resolveWorkspaceConversation("user:normalization-race");
          if (mutation === "delete") {
            expect(resolved).toBeNull();
            expect(readPersistedBinding("user:normalization-race")).toBeNull();
            return;
          }
          expectBindingFields(resolved, {
            targetSessionKey: "agent:codex:acp:latest-target",
          });
          expectBindingMetadata(readPersistedBinding("user:normalization-race"), {
            version: "latest",
            opaque: { preserved: true },
          });
        } finally {
          parseSpy.mockRestore();
        }
      },
    );

    it("does not hide another owner's committed row after a failed write", async () => {
      const owned = expectSessionBinding(await bindWorkspaceConversation("user:owner"));
      seedPersistedBinding({
        ...owned,
        bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:external",
        targetSessionKey: "agent:codex:acp:external-target",
        conversation: workspaceConversation("user:external"),
        metadata: { opaque: { survives: true } },
      });

      await expect(
        withReadOnlyStateDatabase(() =>
          bindWorkspaceConversation("user:owner", {
            targetSessionKey: "agent:codex:acp:failed-target",
          }),
        ),
      ).rejects.toThrow();

      expect(resolveWorkspaceConversation("user:owner")?.targetSessionKey).toBe(
        owned.targetSessionKey,
      );
      expect(resolveWorkspaceConversation("user:external")?.targetSessionKey).toBe(
        "agent:codex:acp:external-target",
      );
      expectBindingMetadata(readPersistedBinding("user:external"), {
        opaque: { survives: true },
      });
    });
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

  it("returns no generic bindings for session keys without an indexable agent owner", async () => {
    await bindWorkspaceConversation("user:U123");

    expect(listGenericCurrentConversationBindingsBySession("agent:main")).toEqual([]);
    expect(listGenericCurrentConversationBindingsBySession("main")).toEqual([]);
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

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
      }),
    ).toBeNull();
  });

  it.each(["touch", "unbind"] as const)(
    "supports %s by the canonical id returned for an unrepaired legacy self-parent row",
    async (operation) => {
      const conversation = {
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
        parentConversationId: "6098642967",
      };
      seedPersistedBinding({
        bindingId: "generic:forum\u241fdefault\u241f6098642967\u241f6098642967",
        targetSessionKey: "agent:codex:acp:forum-dm",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1_234,
        metadata: { opaque: { preserved: true } },
      });

      const listed = expectSessionBinding(
        listGenericCurrentConversationBindingsBySession("agent:codex:acp:forum-dm")[0] ?? null,
      );
      expect(listed.bindingId).toBe("generic:forum\u241fdefault\u241f\u241f6098642967");

      if (operation === "touch") {
        touchGenericCurrentConversationBinding(listed.bindingId, 9_876);
        expectBindingMetadata(resolveGenericCurrentConversationBinding(conversation), {
          opaque: { preserved: true },
          lastActivityAt: 9_876,
        });
        return;
      }

      const removed = await unbindGenericCurrentConversationBindings({
        bindingId: listed.bindingId,
        reason: "legacy owner cleanup",
      });
      expect(removed).toHaveLength(1);
      expect(listGenericCurrentConversationBindingsBySession("agent:codex:acp:forum-dm")).toEqual(
        [],
      );
    },
  );

  it("unbinds durable generic rows without invoking reentrant plugin policy in a write transaction", async () => {
    const targetSessionKey = "agent:codex:acp:workspace-dm";
    const bound = expectSessionBinding(await bindWorkspaceConversation("user:policy-owner"));
    const policy = vi.fn(() => {
      runOpenClawStateWriteTransaction(() => undefined);
      return true;
    });
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
              isCurrentConversationBindingSupported: policy,
            },
          },
        },
      ]),
    );

    const removed = await unbindGenericCurrentConversationBindings({
      targetSessionKey,
      reason: "owner cleanup",
    });

    expect(removed).toEqual([bound]);
    expect(policy).not.toHaveBeenCalled();
    expect(readPersistedBinding("user:policy-owner")).toBeNull();
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

  it("persists touched activity after the state database reopens", async () => {
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

    closeOpenClawStateDatabaseForTest();

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
    it("keeps the committed binding when its replacement write fails", async () => {
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
      closeOpenClawStateDatabaseForTest();
      expect(resolveWorkspaceConversation("user:U1")?.targetSessionKey).toBe(
        "agent:codex:acp:session-a",
      );
    });

    it("keeps committed activity unchanged when a touch write fails", async () => {
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
    });

    it("reads an unexpired binding without requiring a SQLite cleanup write", async () => {
      await bindWorkspaceConversation("user:U1");

      await expect(
        withReadOnlyStateDatabase(() => resolveWorkspaceConversation("user:U1")),
      ).resolves.not.toBeNull();
    });
  });
});
