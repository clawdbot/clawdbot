import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import { getClickClackDiscussionBindingStore } from "./binding-store.js";
import { discussionSessionKey } from "./naming.js";
import { markClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";
import { enforceClickClackDiscussionToolTarget } from "./tool-policy.js";

function createMemoryStore<T>(): PluginStateSyncKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number }>();
  return {
    register: (key, value) => void values.set(key, { value, createdAt: Date.now() }),
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    lookup: (key) => values.get(key)?.value,
    consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () =>
      Array.from(values, ([key, entry]) => ({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
      })),
    clear: () => values.clear(),
  };
}

function setup() {
  const store = createMemoryStore<unknown>();
  const config: CoreConfig = {
    channels: {
      clickclack: {
        enabled: true,
        baseUrl: "https://clickclack.example",
        token: "test-token",
        workspace: "team",
        discussions: { enabled: true, workspace: "team" },
      },
    },
  };
  const runtime = createPluginRuntimeMock({
    config: { current: vi.fn(() => config) },
    state: {
      openSyncKeyedStore: vi.fn(
        () => store,
      ) as unknown as PluginRuntime["state"]["openSyncKeyedStore"],
    },
    agent: {
      session: {
        getSessionEntry: vi.fn(() => ({ sessionId: "session-id", updatedAt: 1 })),
      },
    },
  });
  const mainSessionKey = "agent:research:main";
  const bindingStore = getClickClackDiscussionBindingStore(runtime);
  bindingStore.set(mainSessionKey, {
    accountId: "default",
    agentId: "research",
    sessionId: "session-id",
    serverBaseUrl: "https://clickclack.example",
    externalRef: "openclaw:test:research",
    externalUrl: "",
    workspaceRef: "team",
    workspaceId: "wsp_team",
    channelId: "chn_discussion",
    channelRouteId: "discussion-route",
    workspaceRouteId: "team-route",
    section: "Sessions",
    archived: false,
    label: "Research",
  });
  const sideSessionKey = discussionSessionKey({
    runtime,
    agentId: "research",
    mainSessionKey,
    sessionId: "session-id",
    accountId: "default",
    serverBaseUrl: "https://clickclack.example",
    channelId: "chn_discussion",
    externalRef: "openclaw:test:research",
  });
  if (!sideSessionKey) {
    throw new Error("expected discussion session key");
  }
  const run = (toolName: string, toolParams: Record<string, unknown>) =>
    enforceClickClackDiscussionToolTarget({
      runtime,
      event: { toolName, params: toolParams },
      context: { toolName, sessionKey: sideSessionKey },
    });
  return { bindingStore, config, mainSessionKey, runtime, run, sideSessionKey, store };
}

describe("ClickClack discussion session tool policy", () => {
  it("allows the three observer tools only against the attached main session", () => {
    const { mainSessionKey, run } = setup();

    expect(run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();
    expect(run("session_status", { sessionKey: mainSessionKey, changesSince: 12 })).toBeUndefined();
    expect(
      run("sessions_send", { sessionKey: mainSessionKey, message: "Please pause." }),
    ).toBeUndefined();
  });

  it("blocks cross-session, discovery, alternate-target, and status-mutation calls", () => {
    const { mainSessionKey, run } = setup();

    expect(run("sessions_history", { sessionKey: "agent:research:other" })?.block).toBe(true);
    expect(
      run("sessions_history", { sessionKey: mainSessionKey, sessionId: "old-session" })?.block,
    ).toBe(true);
    expect(run("sessions_list", {})?.block).toBe(true);
    expect(
      run("sessions_send", { sessionKey: mainSessionKey, label: "other", message: "x" })?.block,
    ).toBe(true);
    expect(run("session_status", { sessionKey: mainSessionKey, model: "other/model" })?.block).toBe(
      true,
    );
    expect(run("web_search", { query: "safe" })).toBeUndefined();
  });

  it("revokes the target capability when the ClickClack account is disabled", () => {
    const { config, mainSessionKey, run } = setup();
    config.channels!.clickclack!.enabled = false;

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("web_search", { query: "still unrelated" })).toBeUndefined();
  });

  it("revokes the target capability after a discussion workspace retarget", () => {
    const { config, mainSessionKey, run } = setup();
    config.channels!.clickclack!.discussions!.workspace = "other-team";

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("revokes the target capability when the main session key is reset", () => {
    const { mainSessionKey, run, runtime } = setup();
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
      sessionId: "replacement-session-id",
      updatedAt: 2,
    });

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("revokes the target capability when the main session is archived before sync", () => {
    const { mainSessionKey, run, runtime } = setup();
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
      sessionId: "session-id",
      updatedAt: 2,
      archivedAt: 1,
    });

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("revokes the target capability for a synchronized archived binding", () => {
    const { bindingStore, mainSessionKey, run } = setup();
    const binding = bindingStore.get(mainSessionKey);
    if (!binding) {
      throw new Error("expected binding");
    }
    bindingStore.set(mainSessionKey, { ...binding, archived: true });

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("lets a durable channel tombstone override a surviving binding", () => {
    const { bindingStore, mainSessionKey, run, runtime } = setup();
    const binding = bindingStore.get(mainSessionKey);
    if (!binding) {
      throw new Error("expected binding");
    }
    markClickClackDiscussionChannelRevoked(runtime, binding);

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("revokes the target capability under ambiguous multi-account configuration", () => {
    const { config, mainSessionKey, run } = setup();
    config.channels!.clickclack = {
      accounts: {
        first: {
          baseUrl: "https://clickclack.example",
          token: "test-token",
          workspace: "team",
          discussions: { enabled: true },
        },
        second: {
          baseUrl: "https://clickclack-two.example",
          token: "test-token",
          workspace: "team",
          discussions: { enabled: true },
        },
      },
    };

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
  });

  it("fails closed for a revoked discussion session after its binding is deleted", () => {
    const { bindingStore, mainSessionKey, run } = setup();
    bindingStore.delete(mainSessionKey);

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_list", {})?.block).toBe(true);
  });

  it("preserves routing indexes when persistent binding mutations fail", () => {
    const { bindingStore, mainSessionKey, run, store } = setup();
    const previous = bindingStore.get(mainSessionKey);
    if (!previous) {
      throw new Error("expected binding");
    }
    store.register = vi.fn(() => {
      throw new Error("SQLITE_FULL");
    });

    expect(() =>
      bindingStore.set(mainSessionKey, {
        ...previous,
        channelId: "chn_replacement",
      }),
    ).toThrow("SQLITE_FULL");
    expect(
      bindingStore.getByChannel("https://clickclack.example", "chn_discussion")?.sessionKey,
    ).toBe(mainSessionKey);
    expect(run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();

    store.delete = vi.fn(() => {
      throw new Error("SQLITE_IOERR");
    });
    expect(() => bindingStore.delete(mainSessionKey)).toThrow("SQLITE_IOERR");
    expect(
      bindingStore.getByChannel("https://clickclack.example", "chn_discussion")?.sessionKey,
    ).toBe(mainSessionKey);
  });

  it("uses a different side-session identity after a server retarget", () => {
    const { mainSessionKey, runtime, sideSessionKey } = setup();
    const retargeted = discussionSessionKey({
      runtime,
      agentId: "research",
      mainSessionKey,
      sessionId: "session-id",
      accountId: "default",
      serverBaseUrl: "https://other-clickclack.example",
      channelId: "chn_discussion",
      externalRef: "openclaw:test:research",
    });

    expect(retargeted).not.toBe(sideSessionKey);
  });
});
