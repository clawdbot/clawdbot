import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import { AcpxRuntime } from "./runtime.js";

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

const DOCUMENTED_OPENCLAW_BRIDGE_COMMAND =
  "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main";

function makeRuntime(
  baseStore: TestSessionStore,
  options: Partial<ConstructorParameters<typeof AcpxRuntime>[0]> = {},
): {
  runtime: AcpxRuntime;
  wrappedStore: TestSessionStore & { markFresh: (sessionKey: string) => void };
  delegate: {
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
  };
  bridgeSafeDelegate: {
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
  };
} {
  const runtime = new AcpxRuntime({
    cwd: "/tmp",
    sessionStore: baseStore,
    agentRegistry: {
      resolve: (agentName: string) => (agentName === "openclaw" ? "openclaw acp" : agentName),
      list: () => ["codex", "openclaw"],
    },
    permissionMode: "approve-reads",
    ...options,
  });

  return {
    runtime,
    wrappedStore: (
      runtime as unknown as {
        sessionStore: TestSessionStore & { markFresh: (sessionKey: string) => void };
      }
    ).sessionStore,
    delegate: (
      runtime as unknown as {
        delegate: {
          close: AcpRuntime["close"];
          ensureSession: AcpRuntime["ensureSession"];
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          isHealthy(): boolean;
          probeAvailability(): Promise<void>;
        };
      }
    ).delegate,
    bridgeSafeDelegate: (
      runtime as unknown as {
        bridgeSafeDelegate: {
          close: AcpRuntime["close"];
          ensureSession: AcpRuntime["ensureSession"];
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          isHealthy(): boolean;
          probeAvailability(): Promise<void>;
        };
      }
    ).bridgeSafeDelegate,
  };
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore } = makeRuntime(baseStore);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: "agent:codex:acp:binding:test",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(2);
  });

  it("marks the session fresh after discardPersistentState close", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    const close = vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });

    expect(close).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledOnce();
  });

  it("routes openclaw ensureSession through the bridge-safe delegate when MCP servers are configured", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
    });
    const defaultEnsure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "default",
    });
    const bridgeEnsure = vi.spyOn(bridgeSafeDelegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "bridge",
    });

    const result = await runtime.ensureSession({
      sessionKey: "agent:openclaw:acp:test",
      agent: "openclaw",
      mode: "persistent",
    });

    expect(result.runtimeSessionName).toBe("bridge");
    expect(bridgeEnsure).toHaveBeenCalledOnce();
    expect(defaultEnsure).not.toHaveBeenCalled();
  });

  it("routes non-openclaw sessions through the default delegate", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
    });
    const defaultEnsure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "default",
    });
    const bridgeEnsure = vi.spyOn(bridgeSafeDelegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "bridge",
    });

    const result = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(result.runtimeSessionName).toBe("default");
    expect(defaultEnsure).toHaveBeenCalledOnce();
    expect(bridgeEnsure).not.toHaveBeenCalled();
  });

  it("routes handle-based follow-up calls for openclaw sessions through the bridge-safe delegate", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
    });
    const defaultStatus = vi.spyOn(delegate, "getStatus").mockResolvedValue({
      summary: "default",
    });
    const bridgeStatus = vi.spyOn(bridgeSafeDelegate, "getStatus").mockResolvedValue({
      summary: "bridge",
    });
    const handle: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0]["handle"] = {
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "openclaw-session-handle",
    };

    const status = await runtime.getStatus({ handle });

    expect(status.summary).toBe("bridge");
    expect(bridgeStatus).toHaveBeenCalledWith({ handle });
    expect(defaultStatus).not.toHaveBeenCalled();
  });

  it("keeps MCP-enabled routing when the openclaw agent is overridden to a non-bridge adapter", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "openclaw" ? "codex" : agentName),
        list: () => ["codex", "openclaw"],
      },
    });
    const defaultEnsure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "default",
    });
    const bridgeEnsure = vi.spyOn(bridgeSafeDelegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "bridge",
    });

    const result = await runtime.ensureSession({
      sessionKey: "agent:openclaw:acp:test",
      agent: "openclaw",
      mode: "persistent",
    });

    expect(result.runtimeSessionName).toBe("default");
    expect(defaultEnsure).toHaveBeenCalledOnce();
    expect(bridgeEnsure).not.toHaveBeenCalled();
  });

  it("uses the bridge-safe delegate for any agent mapped to the openclaw bridge command", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? "openclaw acp" : agentName),
        list: () => ["codex", "openclaw"],
      },
    });
    const defaultEnsure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "default",
    });
    const bridgeEnsure = vi.spyOn(bridgeSafeDelegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "bridge",
    });

    const result = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(result.runtimeSessionName).toBe("bridge");
    expect(bridgeEnsure).toHaveBeenCalledOnce();
    expect(defaultEnsure).not.toHaveBeenCalled();
  });

  it("uses the bridge-safe delegate for documented env-wrapped openclaw bridge commands", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "openclaw" ? DOCUMENTED_OPENCLAW_BRIDGE_COMMAND : agentName,
        list: () => ["codex", "openclaw"],
      },
    });
    const defaultEnsure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "default",
    });
    const bridgeEnsure = vi.spyOn(bridgeSafeDelegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "bridge",
    });

    const result = await runtime.ensureSession({
      sessionKey: "agent:openclaw:acp:test",
      agent: "openclaw",
      mode: "persistent",
    });

    expect(result.runtimeSessionName).toBe("bridge");
    expect(bridgeEnsure).toHaveBeenCalledOnce();
    expect(defaultEnsure).not.toHaveBeenCalled();
  });

  it("uses the bridge-safe delegate for local node openclaw entrypoints", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "openclaw" ? "env OPENCLAW_HIDE_BANNER=1 node openclaw.mjs acp" : agentName,
        list: () => ["codex", "openclaw"],
      },
    });
    const defaultEnsure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "default",
    });
    const bridgeEnsure = vi.spyOn(bridgeSafeDelegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:openclaw:acp:test",
      backend: "acpx",
      runtimeSessionName: "bridge",
    });

    const result = await runtime.ensureSession({
      sessionKey: "agent:openclaw:acp:test",
      agent: "openclaw",
      mode: "persistent",
    });

    expect(result.runtimeSessionName).toBe("bridge");
    expect(bridgeEnsure).toHaveBeenCalledOnce();
    expect(defaultEnsure).not.toHaveBeenCalled();
  });

  it("routes follow-up calls by persisted agent command before current config", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:openclaw:acp:test",
        agentCommand: DOCUMENTED_OPENCLAW_BRIDGE_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "openclaw" ? "codex" : agentName),
        list: () => ["codex", "openclaw"],
      },
    });
    const defaultStatus = vi.spyOn(delegate, "getStatus").mockResolvedValue({
      summary: "default",
    });
    const bridgeStatus = vi.spyOn(bridgeSafeDelegate, "getStatus").mockResolvedValue({
      summary: "bridge",
    });

    const status = await runtime.getStatus({
      handle: {
        sessionKey: "agent:openclaw:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:openclaw:acp:test",
      },
    });

    expect(status.summary).toBe("bridge");
    expect(bridgeStatus).toHaveBeenCalledOnce();
    expect(defaultStatus).not.toHaveBeenCalled();
  });

  it("probes through the bridge-safe delegate when probeAgent resolves to openclaw bridge", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
      probeAgent: "openclaw",
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "openclaw" ? DOCUMENTED_OPENCLAW_BRIDGE_COMMAND : agentName,
        list: () => ["codex", "openclaw"],
      },
    });
    const defaultProbe = vi.spyOn(delegate, "probeAvailability").mockResolvedValue(undefined);
    const bridgeProbe = vi
      .spyOn(bridgeSafeDelegate, "probeAvailability")
      .mockResolvedValue(undefined);
    vi.spyOn(delegate, "isHealthy").mockReturnValue(false);
    vi.spyOn(bridgeSafeDelegate, "isHealthy").mockReturnValue(true);

    await runtime.probeAvailability();

    expect(runtime.isHealthy()).toBe(true);
    expect(bridgeProbe).toHaveBeenCalledOnce();
    expect(defaultProbe).not.toHaveBeenCalled();
  });
});
