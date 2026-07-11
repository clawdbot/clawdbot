// Codex tests cover the SQLite-backed thread binding facade.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  readCodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

function createStateStore() {
  const values = new Map<string, StoredCodexAppServerBinding>();
  const state: PluginStateSyncKeyedStore<StoredCodexAppServerBinding> = {
    register(key, value) {
      values.set(key, value);
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (!next) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    lookup: (key) => values.get(key),
    consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
  return { state, values };
}

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding store", () => {
  it("normalizes the retired approval policy in persisted bindings", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-legacy-policy",
        cwd: "/repo",
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
      }),
    ).toMatchObject({
      threadId: "thread-legacy-policy",
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("stores domain data under the canonical session identity", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo", model: "gpt-5.4-codex" },
    });

    const binding = await store.read(identity);
    expect(binding).toMatchObject({ threadId: "thread-1", cwd: "/repo" });
    expect(binding).not.toHaveProperty("sessionFile");
    expect(binding).not.toHaveProperty("schemaVersion");
    expect(values.get("session:main:session-1")).toMatchObject({
      version: 1,
      state: "active",
      binding: { threadId: "thread-1" },
    });
  });

  it("does not report the exact session or conversation binding owner as another owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const sessionIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(sessionIdentity, {
      kind: "set",
      binding: { threadId: "thread-session", cwd: "/repo" },
    });

    await expect(store.hasOtherThreadOwner("thread-session", sessionIdentity)).resolves.toBe(false);

    const conversationIdentity = { kind: "conversation" as const, bindingId: "conversation-1" };
    await store.mutate(conversationIdentity, {
      kind: "set",
      binding: { threadId: "thread-conversation", cwd: "/repo" },
    });
    await expect(
      store.hasOtherThreadOwner("thread-conversation", conversationIdentity),
    ).resolves.toBe(false);
  });

  it("reports a different valid active binding owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(
      { kind: "conversation", bindingId: "conversation-owner" },
      {
        kind: "set",
        binding: { threadId: "thread-owned", cwd: "/repo" },
      },
    );

    await expect(store.hasOtherThreadOwner("thread-owned", currentIdentity)).resolves.toBe(true);
  });

  it.each([
    { name: "a different generation", storedSessionId: "session-previous" },
    { name: "a missing generation", storedSessionId: undefined },
  ])("treats $name under the same stable key as another owner", async ({ storedSessionId }) => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:stable",
    };
    values.set(bindingStoreKey(currentIdentity), {
      version: 1,
      state: "active",
      binding: { threadId: "thread-stale-generation", cwd: "/repo" },
      ...(storedSessionId ? { sessionId: storedSessionId } : {}),
    });

    await expect(
      store.hasOtherThreadOwner("thread-stale-generation", currentIdentity),
    ).resolves.toBe(true);
  });

  it("fails closed on a malformed row during reverse ownership scans", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    values.set("conversation:invalid", {
      version: 1,
      state: "active",
      binding: { threadId: "", cwd: "/repo" },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).rejects.toThrow(
      "Invalid Codex app-server binding row: conversation:invalid",
    );
  });

  it("ignores stale cleared rows during reverse ownership scans", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    values.set("conversation:cleared", {
      version: 1,
      state: "cleared",
      retired: true,
      binding: { threadId: "thread-unowned", cwd: "/repo" },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).resolves.toBe(false);
  });

  it("fails closed on malformed pending supervision state", async () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-source",
          cleanupThreadIds: ["thread-probe", "thread-probe"],
        },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-other",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: { sourceThreadId: "thread-source" },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        pendingSupervisionBranch: { sourceThreadId: "thread-source", unknown: true },
      }),
    ).toBeUndefined();

    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-corrupt",
    };
    state.register(bindingStoreKey(identity), {
      version: 1,
      state: "active",
      binding: {
        threadId: "thread-source",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-source",
          cleanupThreadIds: ["thread-source"],
        },
      },
    } as never);

    await expect(store.read(identity)).rejects.toThrow("Invalid Codex app-server binding row");
  });

  it("fails closed on malformed private supervision ownership", () => {
    const valid = {
      threadId: "thread-source",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-source" },
    };

    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: "user" })).toBeUndefined();
    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: {} })).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({ ...valid, supervisionSourceThreadId: undefined }),
    ).toBeUndefined();
  });

  it("commits a pending supervision branch only from its exact cleanup snapshot", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-supervision-cas",
    };
    const initial = {
      sourceThreadId: "thread-source",
      connectionFingerprint: "connection-one",
      lastTurnId: "turn-terminal",
    };
    await expect(
      store.mutate(identity, {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: "thread-source",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-source",
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          pendingSupervisionBranch: initial,
        },
      }),
    ).resolves.toBe(true);
    const tracked = { ...initial, cleanupThreadIds: ["thread-probe"] };
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, connectionFingerprint: "connection-two" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, lastTurnId: "turn-other" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: initial,
        pending: tracked,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: initial,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: tracked,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(true);
    await expect(store.read(identity)).resolves.toEqual({
      threadId: "thread-final",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      model: "native-model",
      modelProvider: "native-provider",
    });
  });

  it("round-trips account app policy context", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-account" };
    const pluginAppPolicyContext = {
      fingerprint: "account-policy-1",
      apps: {
        "chatgpt-meetings": {
          source: "account" as const,
          appName: "ChatGPT Meetings",
          allowDestructiveActions: true,
          destructiveApprovalMode: "auto" as const,
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-account", cwd: "/repo", pluginAppPolicyContext },
    });
    await expect(store.read(identity)).resolves.toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-account",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("canonicalizes undefined fields before writing to JSON-only plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-json-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const identity = { kind: "conversation" as const, bindingId: "binding-json" };

      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-json",
            cwd: "/repo",
            model: undefined,
            contextEngine: {
              schemaVersion: 1,
              engineId: "lossless-claw",
              policyFingerprint: "policy-1",
              projection: undefined,
            },
          },
        }),
      ).resolves.toBe(true);
      expect(state.lookup(bindingStoreKey(identity))).toEqual({
        version: 1,
        state: "active",
        binding: {
          threadId: "thread-json",
          cwd: "/repo",
          contextEngine: {
            schemaVersion: 1,
            engineId: "lossless-claw",
            policyFingerprint: "policy-1",
          },
        },
      });

      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: "thread-json",
          patch: { contextEngine: undefined },
        }),
      ).resolves.toBe(true);
      await expect(store.read(identity)).resolves.toEqual({
        threadId: "thread-json",
        cwd: "/repo",
      });
      expect(state.lookup(bindingStoreKey(identity))).not.toHaveProperty("lease");
      await expect(store.mutate(identity, { kind: "clear" })).resolves.toBe(true);
      await expect(store.read(identity)).resolves.toBeUndefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps a replacement thread when a stale clear completes later", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-old" })).resolves.toBe(
      false,
    );
    await expect(store.read(identity)).resolves.toMatchObject({ threadId: "thread-new" });
    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-new" })).resolves.toBe(
      true,
    );
    await expect(store.read(identity)).resolves.toBeUndefined();
  });

  it("retains cleared legacy conversation provenance after normal tombstones expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-clear-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const normal = { kind: "conversation" as const, bindingId: "normal" };
      const legacy = { kind: "conversation" as const, bindingId: "legacy-source" };
      for (const identity of [normal, legacy]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.bindingId}`, cwd: "/repo" },
        });
        await store.mutate(identity, { kind: "clear" });
      }

      vi.advanceTimersByTime(10);
      expect(state.lookup(bindingStoreKey(normal))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(legacy))).toEqual({ version: 1, state: "cleared" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("isolates identical session ids owned by different agents", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = { kind: "session" as const, agentId: "first", sessionId: "shared" };
    const second = { kind: "session" as const, agentId: "second", sessionId: "shared" };

    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-first", cwd: "/first" },
    });
    await store.mutate(second, {
      kind: "set",
      binding: { threadId: "thread-second", cwd: "/second" },
    });

    await expect(store.read(first)).resolves.toMatchObject({ threadId: "thread-first" });
    await expect(store.read(second)).resolves.toMatchObject({ threadId: "thread-second" });
    expect(bindingStoreKey({ kind: "session", agentId: " First ", sessionId: "shared" })).toBe(
      "session:first:shared",
    );
  });

  it("keeps one binding across physical session rotations for a stable session key", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };

    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    await expect(store.read(second)).resolves.toBeUndefined();
    await store.withLease(second, async () => undefined);

    expect(bindingStoreKey(first)).toBe(bindingStoreKey(second));
    expect(values.size).toBe(1);
    expect(values.get(bindingStoreKey(second))).toMatchObject({ sessionId: "session-1" });
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
    expect(values.get(bindingStoreKey(second))).toMatchObject({
      state: "active",
      sessionId: "session-2",
      binding: { threadId: "thread-1" },
    });
    await expect(
      store.mutate(first, {
        kind: "patch",
        threadId: "thread-1",
        patch: { model: "stale-model" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(first, { kind: "clear" })).resolves.toBe(false);
    await expect(store.read(second)).resolves.toMatchObject({ threadId: "thread-1" });
    await expect(store.mutate(second, { kind: "clear" })).resolves.toBe(true);
  });

  it("rejects a delayed adoption after a newer session generation wins", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("adopted");
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("current");
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("conflict");
    await expect(store.retireSessionGeneration(second)).resolves.toBe("conflict");

    await expect(store.read(second)).resolves.toBeUndefined();
    await expect(store.read(third)).resolves.toMatchObject({ threadId: "thread-1" });
  });

  it("rejects reclaim when another session generation wins after verification", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    const plan = await store.prepareSessionGenerationReclaim(second);
    expect(plan).toEqual({ kind: "verify", expectedPreviousSessionId: first.sessionId });
    await expect(store.adoptSessionGeneration(third, first.sessionId)).resolves.toBe("adopted");
    if (plan.kind !== "verify") {
      throw new Error("expected stale session generation");
    }
    await expect(
      store.mutate(second, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      }),
    ).resolves.toBe(false);
    await expect(store.read(third)).resolves.toMatchObject({ threadId: "thread-1" });
  });

  it("falls back to physical session identity when no stable session key exists", () => {
    const first = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const second = { ...first, sessionId: "session-2" };

    expect(bindingStoreKey(first)).not.toBe(bindingStoreKey(second));
  });

  it("does not create a retirement tombstone for a session without a Codex binding", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };

    await expect(store.retireSessionGeneration(identity)).resolves.toBe("absent");
    expect(values.size).toBe(0);
  });

  it("expires physical-session retirement fences but retains stable-key fences", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-retirement-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const physical = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "physical-session",
      };
      const stable = {
        ...physical,
        sessionId: "stable-session",
        sessionKey: "agent:main:telegram:chat-1",
      };
      for (const identity of [physical, stable]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.sessionId}`, cwd: "/repo" },
        });
        await expect(store.retireSessionGeneration(identity)).resolves.toBe("applied");
      }

      expect(state.lookup(bindingStoreKey(physical))).toMatchObject({
        state: "cleared",
        retired: true,
      });
      expect(state.lookup(bindingStoreKey(stable))).toMatchObject({
        state: "cleared",
        retired: true,
      });

      vi.advanceTimersByTime(2 * 60_000);

      expect(state.lookup(bindingStoreKey(physical))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(stable))).toMatchObject({
        state: "cleared",
        retired: true,
      });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("claims a cleared binding once without allowing the retired generation back in", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-premature", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);

    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    await expect(store.read(previous)).resolves.toBeUndefined();
    await expect(store.read(current)).resolves.toMatchObject({
      threadId: "thread-new",
      cwd: "/new",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    expect(values.size).toBe(1);
  });

  it("reclaims a stale stable generation only for the current OpenClaw session", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: "other-session",
      }),
    ).resolves.toBe(false);
    expect(values.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: "session-1",
    });

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    expect(values.get(bindingStoreKey(current))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: "session-2",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed-before-commit", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    await expect(
      store.mutate(previous, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(store.read(current)).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("preserves a stale private supervision binding instead of reclaiming it as empty", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:supervised",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: {
        threadId: "thread-supervised",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-source",
        cwd: "/repo",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
      },
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-replacement", cwd: "/other" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, { kind: "clear", threadId: "thread-supervised" }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    expect(values.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: previous.sessionId,
      binding: { threadId: "thread-supervised", connectionScope: "supervision" },
    });
    await expect(store.read(previous)).resolves.toMatchObject({
      threadId: "thread-supervised",
      connectionScope: "supervision",
    });
    await expect(store.read(current)).resolves.toBeUndefined();
  });

  it("fences a retired physical generation until its successor claims the stable key", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });

    await expect(store.retireSessionGeneration(previous)).resolves.toBe("applied");
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(store.withLease(previous, async () => undefined)).rejects.toThrow(
      "generation was retired",
    );

    await store.withLease(current, async () => undefined);
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
      }),
    ).resolves.toBe(true);
    await expect(store.read(current)).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("drains an in-flight ownership mutation and rejects late attachment during archive", async () => {
    const fixture = createStateStore();
    const stateUpdate = fixture.state.update;
    if (!stateUpdate) {
      throw new Error("test state store must support atomic updates");
    }
    const originalUpdate = stateUpdate.bind(fixture.state);
    let startArchive: (() => void) | undefined;
    fixture.state.update = (...args) => {
      startArchive?.();
      startArchive = undefined;
      return originalUpdate(...args);
    };
    const store = createCodexAppServerBindingStore(fixture.state);
    const firstIdentity = { kind: "conversation" as const, bindingId: "first" };
    const lateIdentity = { kind: "conversation" as const, bindingId: "late" };
    let releaseArchive!: () => void;
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archive!: Promise<void>;
    startArchive = () => {
      archive = store.withThreadArchiveFence(async () => {
        await expect(
          store.mutate(firstIdentity, {
            kind: "patch",
            threadId: "thread-before-archive",
            patch: { cwd: "/updated" },
          }),
        ).resolves.toBe(true);
        await archiveReleased;
      });
    };

    await expect(
      store.mutate(firstIdentity, {
        kind: "set",
        binding: { threadId: "thread-before-archive", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    await Promise.resolve();
    await expect(
      store.mutate(lateIdentity, {
        kind: "set",
        binding: { threadId: "thread-late", cwd: "/repo" },
      }),
    ).rejects.toThrow("native archive is in progress");
    releaseArchive();
    await expect(archive).resolves.toBeUndefined();
    await expect(store.read(firstIdentity)).resolves.toMatchObject({ cwd: "/updated" });
    await expect(store.read(lateIdentity)).resolves.toBeUndefined();
  });

  it("hashes stable session keys and keeps agent ownership distinct", () => {
    const sessionKey = "agent:main:telegram:private-peer@example.com";
    const first = bindingStoreKey({
      kind: "session",
      agentId: "first",
      sessionId: "session-1",
      sessionKey,
    });
    const second = bindingStoreKey({
      kind: "session",
      agentId: "second",
      sessionId: "session-2",
      sessionKey,
    });

    expect(first).toMatch(/^session-key:first:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("private-peer");
    expect(second).not.toBe(first);
  });

  it("patches only the expected thread without advancing history implicitly", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    const historyCoveredThrough = "2026-01-01T00:00:00.000Z";
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        model: "gpt-5.4-codex",
        historyCoveredThrough,
      },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-1",
        patch: { serviceTier: "fast" },
      }),
    ).resolves.toBe(true);
    await expect(store.read(identity)).resolves.toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      serviceTier: "priority",
      historyCoveredThrough,
    });
  });

  it("rejects stale patches and absent-only writes", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-old",
        patch: { model: "stale-model" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/repo" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.read(identity)).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("maps the legacy sidecar update timestamp to the history watermark", () => {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt,
    });

    expect(stored?.binding).toMatchObject({ historyCoveredThrough: updatedAt });
    expect(stored?.binding).not.toHaveProperty("createdAt");
    expect(stored?.binding).not.toHaveProperty("updatedAt");
  });

  it("normalizes version 1 destructive approval modes during import", () => {
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {
          allow: {
            configKey: "allow",
            marketplaceName: "openai-curated",
            pluginName: "allow-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
            mcpServerNames: [],
          },
          prompt: {
            configKey: "prompt",
            marketplaceName: "openai-curated",
            pluginName: "prompt-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "on-request",
            mcpServerNames: [],
          },
        },
        pluginAppIds: {},
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.allow?.destructiveApprovalMode).toBe(
      "allow",
    );
    expect(stored?.binding.pluginAppPolicyContext?.apps.prompt?.destructiveApprovalMode).toBe(
      "auto",
    );
  });

  it("preserves version 2 ask approval mode and drops invalid policy contexts", () => {
    const policyContext = {
      fingerprint: "policy-2",
      apps: {
        app: {
          configKey: "app",
          marketplaceName: "openai-curated",
          pluginName: "plugin",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-2",
      cwd: "/repo",
      pluginAppPolicyContext: policyContext,
    });
    const invalid = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-invalid",
      cwd: "/repo",
      pluginAppPolicyContext: {
        ...policyContext,
        apps: { app: { ...policyContext.apps.app, appId: "not-allowed" } },
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.app?.destructiveApprovalMode).toBe("ask");
    expect(invalid?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("serializes writes from another facade behind a native-compaction lease", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(identity, async () => {
      peerWrite = peer
        .mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-2", cwd: "/repo" },
        })
        .then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await peerWrite;

    await expect(peer.read(identity)).resolves.toMatchObject({ threadId: "thread-2" });
  });

  it("leases an absent binding before creating its first thread", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-new" };
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(identity, async () => {
      peerWrite = peer
        .mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-peer", cwd: "/repo" },
          if: { kind: "absent" },
        })
        .then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
      await expect(
        owner.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-owner", cwd: "/repo" },
          if: { kind: "absent" },
        }),
      ).resolves.toBe(true);
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(peerWrite).resolves.toBe(false);
    await expect(owner.read(identity)).resolves.toMatchObject({ threadId: "thread-owner" });
  });

  it("releases a lease when its owner callback rejects", async () => {
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-rejected-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });

    await expect(
      owner.withLease(identity, async () => {
        throw new Error("owner failed");
      }),
    ).rejects.toThrow("owner failed");
    await expect(
      peer.mutate(identity, {
        kind: "patch",
        threadId: "thread-owner",
        patch: { serviceTier: "priority" },
      }),
    ).resolves.toBe(true);
  });

  it("renews a live lease across a long app-server request", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-renewed-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.withLease(identity, async () => {
      markOwnerStarted();
      await holdOwner;
      return await owner.mutate(identity, {
        kind: "patch",
        threadId: "thread-owner",
        patch: { serviceTier: "priority" },
      });
    });
    await ownerStarted;
    let peerFinished = false;
    const peerWrite = peer
      .mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-peer", cwd: "/repo" },
      })
      .then((result) => {
        peerFinished = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(66_000);
    expect(peerFinished).toBe(false);
    releaseOwner();
    await expect(ownerRun).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerWrite).resolves.toBe(true);
    await expect(peer.read(identity)).resolves.toMatchObject({ threadId: "thread-peer" });
  });

  it("fences an expired lease owner after a peer takes over", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-stale-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });

    await expect(
      owner.withLease(identity, async () => {
        vi.setSystemTime(Date.now() + 66_000);
        await peer.withLease(identity, async () => {
          await expect(
            peer.mutate(identity, {
              kind: "set",
              binding: { threadId: "thread-peer", cwd: "/repo" },
            }),
          ).resolves.toBe(true);
        });
        await owner.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-stale", cwd: "/repo" },
        });
      }),
    ).rejects.toThrow("Lost Codex binding lease");

    await expect(owner.read(identity)).resolves.toMatchObject({ threadId: "thread-peer" });
  });

  it("surfaces heartbeat lease loss without deleting the replacement owner", async () => {
    vi.useFakeTimers();
    const { state, values } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-replaced-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.withLease(identity, async () => {
      markOwnerStarted();
      await holdOwner;
    });
    await ownerStarted;
    const key = bindingStoreKey(identity);
    const current = values.get(key)!;
    values.set(key, {
      ...current,
      lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    releaseOwner();
    await expect(ownerRun).rejects.toThrow("Lost Codex binding lease");
    expect(values.get(key)?.lease?.token).toBe("peer-owner");
  });

  it("rejects empty storage identities", () => {
    expect(() => bindingStoreKey({ kind: "session", agentId: "main", sessionId: " " })).toThrow(
      "requires a session id",
    );
    expect(() =>
      bindingStoreKey({ kind: "session", agentId: " ", sessionId: "session-1" }),
    ).toThrow("requires an agent id");
  });
});
