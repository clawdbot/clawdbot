import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ChatComposerCapabilityHost } from "./chat-composer-capability-host.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

function createContext(configSnapshot: ConfigSnapshot | null): ApplicationContext {
  return {
    gateway: { snapshot: { hello: null } },
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
