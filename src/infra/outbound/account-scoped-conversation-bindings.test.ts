import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
  type AccountScopedConversationBindingManager,
} from "./account-scoped-conversation-bindings.js";
import { testing as currentConversationBindingTesting } from "./current-conversation-bindings.js";
import { getSessionBindingService } from "./session-binding-service.js";

type TestBindingKind = "subagent" | "acp";

const stateKey = Symbol("openclaw.accountScopedConversationBindingExpiry.test");
const startedAt = 1_700_000_000_000;
const baseCfg = {
  session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } },
} satisfies OpenClawConfig;

function createManager(params: { accountId?: string; cfg?: OpenClawConfig } = {}) {
  return createAccountScopedConversationBindingManager<TestBindingKind>({
    channel: "imessage",
    cfg: params.cfg ?? baseCfg,
    accountId: params.accountId ?? "ttl-owner",
    stateKey,
    toStoredTargetKind: (kind) => (kind === "subagent" ? "subagent" : "acp"),
    toSessionBindingTargetKind: (kind) => (kind === "subagent" ? "subagent" : "session"),
  });
}

function bindConversation(
  manager: AccountScopedConversationBindingManager<TestBindingKind>,
  params: {
    conversationId?: string;
    targetSessionKey?: string;
    label?: string;
  } = {},
) {
  const binding = manager.bindConversation({
    conversationId: params.conversationId ?? "chat:ttl-owner",
    targetKind: "subagent",
    targetSessionKey: params.targetSessionKey ?? "agent:main:subagent:ttl-owner",
    ...(params.label ? { metadata: { label: params.label } } : {}),
  });
  if (!binding) {
    throw new Error("expected an account-scoped conversation binding");
  }
  return binding;
}

describe("account-scoped conversation binding expiry", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-account-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    resetAccountScopedConversationBindingsForTests({ stateKey });
    currentConversationBindingTesting.clearPersistedCurrentConversationBindingsForTests();
  });

  afterEach(async () => {
    resetAccountScopedConversationBindingsForTests({ stateKey });
    currentConversationBindingTesting.clearPersistedCurrentConversationBindingsForTests();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("preserves account-owned bindings after stop, manager recreation, and database reopen", () => {
    const manager = createManager();
    const binding = bindConversation(manager, { conversationId: "chat:durable-owner" });
    const conversation = {
      channel: "imessage",
      accountId: manager.accountId,
      conversationId: binding.conversationId,
    };

    expect(getSessionBindingService().resolveByConversation(conversation)?.bindingId).toBe(
      "ttl-owner:chat:durable-owner",
    );

    manager.stop();
    closeOpenClawStateDatabaseForTest();

    const restarted = createManager();
    manager.stop();
    expect(createManager()).toBe(restarted);
    expect(restarted.getByConversationId(binding.conversationId)).toEqual(binding);
    expect(getSessionBindingService().resolveByConversation(conversation)).toMatchObject({
      bindingId: "ttl-owner:chat:durable-owner",
      targetKind: "subagent",
      targetSessionKey: binding.targetSessionKey,
    });
  });

  it.each(["agent", "plugin"] as const)(
    "preserves opaque %s binding metadata through recreation",
    async (ownerKind) => {
      const cfg = {
        ...baseCfg,
        agents: { entries: { alpha: {}, beta: {} } },
      } satisfies OpenClawConfig;
      const manager = createManager({ cfg });
      const metadata = {
        ...(ownerKind === "agent" ? { agentId: "alpha" } : {}),
        label: "durable label",
        boundBy: "operator",
        pluginBindingOwner: "plugin",
        pluginId: "opaque-plugin",
        pluginRoot: "/plugins/opaque-plugin",
        nested: { ownerEpoch: 7, capabilities: ["approve", "resume"] },
      };
      const conversation = {
        channel: "imessage",
        accountId: manager.accountId,
        conversationId: "chat:opaque-metadata",
      };
      const bound = await getSessionBindingService().bind({
        targetSessionKey:
          ownerKind === "agent"
            ? "agent:alpha:acp:opaque-session"
            : "plugin-binding:opaque-plugin:opaque-session",
        targetKind: "session",
        conversation,
        metadata,
      });

      expect(bound.bindingId).toBe("ttl-owner:chat:opaque-metadata");
      expect(bound.metadata).toMatchObject(metadata);
      expect(bound.metadata?.agentId).toBe(ownerKind === "agent" ? "alpha" : undefined);
      expect(manager.getByConversationId(conversation.conversationId)?.targetKind).toBe("acp");
      await expect(
        getSessionBindingService().bind({
          conversation,
          targetSessionKey: bound.targetSessionKey,
          targetKind: bound.targetKind,
        }),
      ).resolves.toMatchObject({ metadata });

      manager.stop();
      closeOpenClawStateDatabaseForTest();
      createManager({ cfg });

      expect(getSessionBindingService().resolveByConversation(conversation)).toMatchObject({
        bindingId: "ttl-owner:chat:opaque-metadata",
        targetKind: "session",
        metadata,
      });
    },
  );

  it("keeps the previously committed account binding visible when its replacement write fails", () => {
    const manager = createManager();
    const original = bindConversation(manager, {
      conversationId: "chat:write-failure",
      targetSessionKey: "agent:main:subagent:committed-owner",
    });
    const { db } = openOpenClawStateDatabase();
    db.exec("PRAGMA query_only = ON");
    try {
      expect(() =>
        manager.bindConversation({
          conversationId: original.conversationId,
          targetKind: "session",
          targetSessionKey: "agent:main:acp:uncommitted-owner",
          metadata: { label: "must-not-leak" },
        }),
      ).toThrow();
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }

    expect(manager.getByConversationId(original.conversationId)).toEqual(original);
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "imessage",
        accountId: manager.accountId,
        conversationId: original.conversationId,
      })?.targetSessionKey,
    ).toBe(original.targetSessionKey);
  });

  it.each([false, true])(
    "inherits runtime metadata only when refreshing the same target (replace=%s)",
    async (replace) => {
      const manager = createManager();
      const service = getSessionBindingService();
      const conversation = {
        channel: "imessage",
        accountId: manager.accountId,
        conversationId: "chat:replacement-owner",
      };
      const metadata = {
        pluginBindingOwner: "plugin",
        pluginId: "owner-plugin",
        pluginRoot: "/plugins/owner-plugin",
        agentId: "previous-agent",
        boundBy: "previous-user",
        opaque: { runtimeId: "original" },
      };
      const originalTarget = "plugin-binding:owner-plugin:original";
      await service.bind({
        targetSessionKey: originalTarget,
        targetKind: "session",
        conversation,
        metadata,
      });
      const targetSessionKey = replace ? "agent:main:acp:replacement" : originalTarget;

      await service.bind({
        targetSessionKey,
        targetKind: "session",
        conversation,
        metadata: { label: "updated" },
      });
      manager.stop();
      closeOpenClawStateDatabaseForTest();
      createManager();

      expect(service.resolveByConversation(conversation)).toMatchObject({
        targetSessionKey,
        metadata: {
          agentId: replace ? "main" : "previous-agent",
          label: "updated",
        },
      });
      const resolvedMetadata = service.resolveByConversation(conversation)?.metadata;
      for (const key of [
        "pluginBindingOwner",
        "pluginId",
        "pluginRoot",
        "boundBy",
        "opaque",
      ] as const) {
        expect(resolvedMetadata?.[key]).toEqual(replace ? undefined : metadata[key]);
      }
    },
  );

  it("expires idle bindings from both manager and session-service lookups", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager();
    const binding = bindConversation(manager);
    const service = getSessionBindingService();
    const conversation = {
      channel: "imessage",
      accountId: manager.accountId,
      conversationId: binding.conversationId,
    };

    expect(service.resolveByConversation(conversation)?.expiresAt).toBe(startedAt + 3_600_000);
    expect(service.listBySession(binding.targetSessionKey)).toHaveLength(1);

    now.mockReturnValue(startedAt + 3_600_000);

    expect(manager.getByConversationId(binding.conversationId)).toBeUndefined();
    expect(manager.listBySessionKey(binding.targetSessionKey)).toEqual([]);
    expect(service.resolveByConversation(conversation)).toBeNull();
    expect(service.listBySession(binding.targetSessionKey)).toEqual([]);
  });

  it("enforces maximum age even when activity refreshes the idle deadline", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager({
      cfg: { session: { threadBindings: { idleHours: 2, maxAgeHours: 1 } } },
    });
    const binding = bindConversation(manager);

    now.mockReturnValue(startedAt + 30 * 60_000);
    expect(manager.touchConversation(binding.conversationId)?.lastActivityAt).toBe(
      startedAt + 30 * 60_000,
    );
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "imessage",
        accountId: manager.accountId,
        conversationId: binding.conversationId,
      })?.expiresAt,
    ).toBe(startedAt + 60 * 60_000);

    now.mockReturnValue(startedAt + 60 * 60_000);

    expect(manager.getByConversationId(binding.conversationId)).toBeUndefined();
    expect(manager.listBySessionKey(binding.targetSessionKey)).toEqual([]);
  });

  it("does not revive an expired binding when its conversation is touched", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager();
    const binding = bindConversation(manager);

    now.mockReturnValue(startedAt + 3_600_000);

    expect(manager.touchConversation(binding.conversationId, startedAt + 3_600_001)).toBeNull();
    expect(manager.getByConversationId(binding.conversationId)).toBeUndefined();
    expect(manager.listBySessionKey(binding.targetSessionKey)).toEqual([]);
  });

  it("does not inherit metadata from an expired binding when rebinding", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager();
    const expired = bindConversation(manager, { label: "expired-owner" });

    now.mockReturnValue(startedAt + 3_600_000);

    const replacement = bindConversation(manager, {
      conversationId: expired.conversationId,
      targetSessionKey: "agent:main:subagent:replacement",
    });

    expect(replacement.label).toBeUndefined();
    expect(replacement.targetSessionKey).toBe("agent:main:subagent:replacement");
    expect(manager.getByConversationId(expired.conversationId)).toEqual(replacement);
  });

  it("prunes only the expired account when accounts share a conversation id", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const expiredManager = createManager({ accountId: "ttl-expired" });
    const expired = bindConversation(expiredManager, { conversationId: "chat:shared" });

    now.mockReturnValue(startedAt + 30 * 60_000);
    const activeManager = createManager({ accountId: "ttl-active" });
    const active = bindConversation(activeManager, { conversationId: "chat:shared" });

    now.mockReturnValue(startedAt + 60 * 60_000);

    expect(expiredManager.getByConversationId(expired.conversationId)).toBeUndefined();
    expect(activeManager.getByConversationId(active.conversationId)).toEqual(active);
    expect(activeManager.listBySessionKey(active.targetSessionKey)).toEqual([active]);
  });

  it("preserves bindings with disabled idle and maximum-age expiry", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager({
      cfg: { session: { threadBindings: { idleHours: 0, maxAgeHours: 0 } } },
    });
    const binding = bindConversation(manager);

    now.mockReturnValue(startedAt + 10 * 365 * 24 * 60 * 60_000);

    expect(manager.getByConversationId(binding.conversationId)).toEqual(binding);
    expect(manager.listBySessionKey(binding.targetSessionKey)).toEqual([binding]);
    expect(manager.touchConversation(binding.conversationId)?.lastActivityAt).toBe(Date.now());
    expect(manager.unbindConversation(binding.conversationId)?.targetSessionKey).toBe(
      binding.targetSessionKey,
    );
  });

  it("derives the binding owner from an agent-scoped target before consulting defaults", () => {
    const manager = createManager({
      cfg: {
        agents: { list: [{ id: "main" }, { id: "molty" }] },
        session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } },
      },
    });

    const binding = bindConversation(manager, {
      targetSessionKey: "agent:molty:subagent:binding-owner",
    });

    expect(binding.agentId).toBe("molty");
  });
});
