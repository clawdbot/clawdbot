import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
  type AccountScopedConversationBindingManager,
} from "./account-scoped-conversation-bindings.js";
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
  beforeEach(() => {
    resetAccountScopedConversationBindingsForTests({ stateKey });
  });

  afterEach(() => {
    resetAccountScopedConversationBindingsForTests({ stateKey });
    vi.restoreAllMocks();
  });

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
    expect(manager.getByConversationId(expired.conversationId)).toBe(replacement);
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
    expect(activeManager.getByConversationId(active.conversationId)).toBe(active);
    expect(activeManager.listBySessionKey(active.targetSessionKey)).toEqual([active]);
  });

  it("preserves bindings with disabled idle and maximum-age expiry", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager({
      cfg: { session: { threadBindings: { idleHours: 0, maxAgeHours: 0 } } },
    });
    const binding = bindConversation(manager);

    now.mockReturnValue(startedAt + 10 * 365 * 24 * 60 * 60_000);

    expect(manager.getByConversationId(binding.conversationId)).toBe(binding);
    expect(manager.listBySessionKey(binding.targetSessionKey)).toEqual([binding]);
    expect(manager.touchConversation(binding.conversationId)?.lastActivityAt).toBe(Date.now());
    expect(manager.unbindConversation(binding.conversationId)?.targetSessionKey).toBe(
      binding.targetSessionKey,
    );
  });
});
