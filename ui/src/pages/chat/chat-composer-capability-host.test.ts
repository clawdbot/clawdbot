import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SkillsLibraryListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  gatewayHelloForMethods,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import { ChatComposerCapabilityHost } from "./chat-composer-capability-host.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

function createContext(configSnapshot: ConfigSnapshot | null): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client: {} as GatewayBrowserClient,
        phase: "connected",
        hello: sessionMutationGatewayHello(["operator.admin", "operator.write"]),
      },
    },
    navigate: vi.fn(),
    runtimeConfig: {
      ensureLoaded: vi.fn(async () => undefined),
      state: { configLoading: false, configSnapshot },
    },
    sessions: { state: { modelOverrides: {} } },
  } as unknown as ApplicationContext;
}

function createState(): ChatPageHost {
  return {
    basePath: "",
    client: {} as GatewayBrowserClient,
    connected: true,
    sessionKey: "main",
  } as ChatPageHost;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ChatComposerCapabilityHost", () => {
  it("adds an everywhere server globally without a session patch", async () => {
    const events: string[] = [];
    const patchSession = vi.fn(async () => {
      events.push("session");
      return { ok: true } as const;
    });
    const loadSessionOverrides = vi.fn(async () => {
      events.push("load");
      return { ok: true, overrides: undefined } as const;
    });

    const result = await ChatComposerCapabilityHost.addMcpServer({
      scope: "everywhere",
      name: "docs",
      config: { url: "https://mcp.example.test", transport: "streamable-http" },
      patchGlobal: async (config) => {
        events.push("global");
        expect(config).toEqual({
          url: "https://mcp.example.test",
          transport: "streamable-http",
        });
        return { ok: true };
      },
      loadSessionOverrides,
      patchSession,
    });

    expect(result).toEqual({ ok: true });
    expect(events).toEqual(["global"]);
    expect(loadSessionOverrides).not.toHaveBeenCalled();
    expect(patchSession).not.toHaveBeenCalled();
  });

  it("adds a session server disabled globally before enabling its sparse override", async () => {
    const events: string[] = [];

    const result = await ChatComposerCapabilityHost.addMcpServer({
      scope: "session",
      name: "docs",
      config: { command: "docs-mcp" },
      patchGlobal: async (config) => {
        events.push("global");
        expect(config).toEqual({ command: "docs-mcp", enabled: false });
        return { ok: true };
      },
      loadSessionOverrides: async () => {
        events.push("load");
        return { ok: true, overrides: { skills: { release: false } } };
      },
      patchSession: async (next) => {
        events.push("session");
        expect(next).toEqual({
          mcpServers: { docs: true },
          skills: { release: false },
        });
        return { ok: true };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(events).toEqual(["global", "load", "session"]);
  });

  it("does not patch the session when the global add fails", async () => {
    const patchSession = vi.fn(async () => ({ ok: true }) as const);
    const loadSessionOverrides = vi.fn(async () => ({ ok: true, overrides: undefined }) as const);

    const result = await ChatComposerCapabilityHost.addMcpServer({
      scope: "session",
      name: "docs",
      config: { command: "docs-mcp" },
      patchGlobal: async () => ({ ok: false, error: "duplicate" }),
      loadSessionOverrides,
      patchSession,
    });

    expect(result).toEqual({ ok: false, error: "duplicate", stage: "config" });
    expect(patchSession).not.toHaveBeenCalled();
    expect(loadSessionOverrides).not.toHaveBeenCalled();
  });

  it("classifies a thrown global write as a config-stage failure", async () => {
    const result = await ChatComposerCapabilityHost.addMcpServer({
      scope: "everywhere",
      name: "docs",
      config: { command: "docs-mcp" },
      patchGlobal: async () => {
        throw new Error("config failed");
      },
      loadSessionOverrides: async () => ({ ok: true, overrides: undefined }),
      patchSession: async () => ({ ok: true }),
    });

    expect(result).toEqual({ ok: false, error: "config failed", stage: "config" });
  });

  it("reports a session-stage failure after retaining the global add", async () => {
    const events: string[] = [];

    const result = await ChatComposerCapabilityHost.addMcpServer({
      scope: "session",
      name: "docs",
      config: { command: "docs-mcp" },
      patchGlobal: async () => {
        events.push("global");
        return { ok: true };
      },
      loadSessionOverrides: async () => {
        events.push("load");
        return { ok: true, overrides: undefined };
      },
      patchSession: async () => {
        events.push("session");
        return { ok: false, error: "gateway disconnected" };
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "gateway disconnected",
      stage: "session",
    });
    expect(events).toEqual(["global", "load", "session"]);
  });

  it("aborts the session stage when navigation changes the submitted identity", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const refresh = vi.fn(async () => undefined);
    const state = {
      ...createState(),
      sessionKey: "other",
      sessions: {
        refresh,
        state: { agentId: "main", error: null, result: null },
      },
    } as unknown as ChatPageHost;
    const loadCurrentSessionOverrides = (
      host as unknown as {
        loadCurrentSessionOverrides: (
          state: ChatPageHost,
          sessionKey: string,
          agentId: string | undefined,
        ) => Promise<{ ok: boolean; error?: string }>;
      }
    ).loadCurrentSessionOverrides;

    expect(await loadCurrentSessionOverrides.call(host, state, "main", "main")).toEqual({
      ok: false,
      error: "The active session changed before it could be enabled.",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns a session-stage error when refreshing current overrides rejects", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const state = {
      ...createState(),
      sessions: {
        refresh: vi.fn(async () => {
          throw new Error("refresh failed");
        }),
        state: { agentId: "main", error: null, result: null },
      },
    } as unknown as ChatPageHost;
    const loadCurrentSessionOverrides = (
      host as unknown as {
        loadCurrentSessionOverrides: (
          state: ChatPageHost,
          sessionKey: string,
          agentId: string | undefined,
        ) => Promise<{ ok: boolean; error?: string }>;
      }
    ).loadCurrentSessionOverrides;

    expect(await loadCurrentSessionOverrides.call(host, state, "main", "main")).toEqual({
      ok: false,
      error: "refresh failed",
    });
  });

  it("blocks session mutations until the row and runtime config have loaded", () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext(null);
    const state = createState();
    const session = { key: "main" } as GatewaySessionRow;

    expect(host.props(context, state, undefined, "main").mutationBlockedReason).toBe("Loading…");
    expect(host.props(context, state, session, "main").mutationBlockedReason).toBe("Loading…");

    context.runtimeConfig.state.configSnapshot = {
      runtimeConfig: { tools: { web: { search: { enabled: false } } } },
    };
    const props = host.props(context, state, session, "main");
    expect(props.mutationBlockedReason).toBeNull();
    expect(props.webSearchBaseEnabled).toBe(false);
  });

  it("blocks tool override patches without exact sessions.patch access", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ runtimeConfig: {} });
    context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["tools.effective"] },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    const request = vi.fn();
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    const props = host.props(context, state, session, "main");
    expect(props.mutationBlockedReason).toBeTruthy();
    const result = await (
      host as unknown as {
        patch: (
          context: ApplicationContext,
          state: ChatPageHost,
          next: { skills: Record<string, boolean> },
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
      }
    ).patch(context, state, { skills: { release: true } });

    expect(result).toEqual({ ok: false, error: props.mutationBlockedReason });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps Everywhere selectable while a missing session row blocks session submit", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ runtimeConfig: {} });
    const state = createState();
    host.props(context, state, undefined, "main").onAddServer?.();
    const container = document.createElement("div");
    render(host.renderAddServerDialog(context, state, undefined), container);
    await Promise.resolve();

    const scope = container.querySelector<HTMLElement & { disabled: boolean }>("wa-radio-group");
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(scope?.disabled).toBe(false);
    expect(submit?.disabled).toBe(true);
  });

  it("blocks session submit before global config while an override patch is in flight", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ runtimeConfig: {} });
    const state = createState();
    const session = { key: "main" } as GatewaySessionRow;
    const props = host.props(context, state, session, "main");
    (
      host as unknown as {
        patchTokens: Map<string, symbol>;
      }
    ).patchTokens.set("main", Symbol("pending"));
    props.onAddServer?.();
    const container = document.createElement("div");
    render(host.renderAddServerDialog(context, state, session), container);
    await Promise.resolve();

    const scope = container.querySelector<HTMLElement & { disabled: boolean }>("wa-radio-group");
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(scope?.disabled).toBe(false);
    expect(submit?.disabled).toBe(true);
    expect(submit?.title).toContain("current session capability change");
  });

  it("derives capability defaults from the active runtime snapshot", () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const props = host.props(
      createContext({
        sourceConfig: {
          mcp: { servers: { source: { command: "source-mcp", enabled: true } } },
          tools: { web: { search: { enabled: false } } },
        },
        runtimeConfig: {
          mcp: { servers: { runtime: { command: "runtime-mcp", enabled: false } } },
          tools: { web: { search: { enabled: true } } },
        },
      }),
      createState(),
      { key: "main" } as GatewaySessionRow,
      "main",
    );

    expect(props.mcpServers.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: "runtime", enabled: false },
    ]);
    expect(props.webSearchBaseEnabled).toBe(true);
  });

  it("refetches effective tools when an active connector definition changes", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({
      appliedConfigHash: "config-1",
      runtimeConfig: {
        mcp: { servers: { github: { url: "https://mcp.example.test", enabled: true } } },
      },
    });
    context.gateway.snapshot.hello = {
      features: { methods: ["tools.effective"] },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    const firstResult = { agentId: "main", groups: [], profile: "full" };
    const secondResult = { agentId: "main", groups: [], profile: "minimal" };
    const request = vi.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult).toBe(firstResult);
    });

    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-2",
      runtimeConfig: {
        mcp: {
          servers: {
            github: { url: "https://new-mcp.example.test", enabled: true },
          },
        },
      },
    };
    expect(host.props(context, state, session, "main").toolsEffectiveLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.props(context, state, session, "main", true).toolsEffectiveLoading).toBe(true);

    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult).toBe(secondResult);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest tools after connector configuration changes away and back", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ appliedConfigHash: "config-a", runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-b",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-a",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    expect(request).toHaveBeenCalledTimes(3);

    third.resolve({ agentId: "main", profile: "newest-a", groups: [] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
        "newest-a",
      );
    });
    first.resolve({ agentId: "main", profile: "stale-a", groups: [] });
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
      "newest-a",
    );
    second.resolve({ agentId: "main", profile: "stale-b", groups: [] });
  });

  it("keeps a replacement tools request loading when its same-key predecessor finishes", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ appliedConfigHash: "config-a", runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-b",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-a",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    first.resolve({ agentId: "main", profile: "stale-a", groups: [] });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.props(context, state, session, "main").toolsEffectiveResult).toBeNull();
    expect(host.props(context, state, session, "main").toolsEffectiveLoading).toBe(true);

    third.resolve({ agentId: "main", profile: "newest-a", groups: [] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
        "newest-a",
      );
    });
    second.resolve({ agentId: "main", profile: "stale-b", groups: [] });
  });

  it("retires effective tools and requests across a same-client reconnect", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ appliedConfigHash: "config-a", runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    const first = deferred<unknown>();
    const current = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    state.connectionEpoch = 1;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    state.connectionEpoch = 2;
    const reconnected = host.props(context, state, session, "main");
    expect(reconnected.toolsEffectiveResult).toBeNull();
    expect(reconnected.toolsEffectiveLoading).toBe(false);
    reconnected.onOpenToolAccess?.("github");
    expect(request).toHaveBeenCalledTimes(2);

    first.resolve({ agentId: "main", profile: "retired-connection", groups: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.props(context, state, session, "main").toolsEffectiveResult).toBeNull();
    expect(host.props(context, state, session, "main").toolsEffectiveLoading).toBe(true);

    current.resolve({ agentId: "main", profile: "current-connection", groups: [] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
        "current-connection",
      );
    });
  });

  it("retires cached skills and their requests across a same-client reconnect", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ runtimeConfig: {} });
    const first = deferred<unknown>();
    const current = deferred<unknown>();
    const statusRequest = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(current.promise);
    const library: SkillsLibraryListResult = {
      entries: [],
      profileId: null,
      multipleProfiles: false,
      defaultTarget: "workspace",
      canManageWorkspace: true,
      defaultSelectionLimit: 64,
      session: { sessionKey: "main", selections: [], attachable: [] },
    };
    const request = vi.fn((method: string) => {
      if (method === "skills.status") {
        return statusRequest();
      }
      if (method === "skills.library.list") {
        return Promise.resolve(library);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    state.connectionEpoch = 1;
    const session = { key: "main" } as GatewaySessionRow;
    const skill = (name: string) => ({
      name,
      skillKey: name,
      disabled: false,
      blockedByAllowlist: false,
      missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    });

    host.props(context, state, session, "main").onLoadSkills?.();
    state.connectionEpoch = 2;
    const reconnected = host.props(context, state, session, "main");
    expect(reconnected.skills).toBeNull();
    expect(reconnected.skillsLoading).toBe(false);
    reconnected.onLoadSkills?.();
    expect(statusRequest).toHaveBeenCalledTimes(2);
    expect(request.mock.calls).toEqual([
      ["skills.status", { agentId: "main" }],
      ["skills.library.list", { sessionKey: "main" }],
      ["skills.status", { agentId: "main" }],
      ["skills.library.list", { sessionKey: "main" }],
    ]);

    first.resolve({ skills: [skill("retired")] });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.props(context, state, session, "main").skills).toBeNull();
    expect(host.props(context, state, session, "main").skillsLoading).toBe(true);

    current.resolve({ skills: [skill("current")] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").skills?.map(({ name }) => name)).toEqual([
        "current",
      ]);
    });
  });

  it("records an unexpected effective-tools loader rejection", async () => {
    const notify = vi.fn();
    const host = new ChatComposerCapabilityHost(notify);
    const context = createContext({ runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    let stateReads = 0;
    Object.defineProperty(context.sessions, "state", {
      configurable: true,
      get: () => {
        stateReads += 1;
        if (stateReads === 3) {
          throw new Error("unexpected loader failure");
        }
        return { modelOverrides: {} };
      },
    });
    const state = createState();
    const request = vi.fn().mockResolvedValue({ agentId: "main", groups: [], profile: "full" });
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveError).toBe(true);
    });

    expect(host.props(context, state, session, "main").toolAccessMutationBlockedReason).toBe(
      "Couldn’t load tools.",
    );

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult).not.toBeNull();
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
