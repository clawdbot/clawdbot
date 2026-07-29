import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ChatComposerCapabilityHost } from "./chat-composer-capability-host.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

function createContext(configSnapshot: ConfigSnapshot | null): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        phase: "connected",
        hello: {
          auth: { role: "operator", scopes: ["operator.admin", "operator.write"] },
        },
      },
    },
    navigate: vi.fn(),
    runtimeConfig: {
      ensureLoaded: vi.fn(async () => undefined),
      state: { configLoading: false, configSnapshot },
    },
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
});
