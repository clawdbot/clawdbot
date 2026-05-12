import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError, type AcpRuntime } from "../runtime-api.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import { AcpxRuntime, __testing } from "./runtime.js";

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

const DOCUMENTED_OPENCLAW_BRIDGE_COMMAND =
  "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main";
const CODEX_ACP_COMMAND = "npx @zed-industries/codex-acp@0.13.0";
const CODEX_ACP_WRAPPER_COMMAND = `node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"`;
const CODEX_ACP_WRAPPER_COMMAND_WITH_LEASE = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;

function makeRuntime(
  baseStore: TestSessionStore,
  options: Partial<ConstructorParameters<typeof AcpxRuntime>[0]> = {},
  testOptions?: ConstructorParameters<typeof AcpxRuntime>[1],
): {
  runtime: AcpxRuntime;
  wrappedStore: TestSessionStore & { markFresh: (sessionKey: string) => void };
  delegate: {
    cancel: AcpRuntime["cancel"];
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
  };
  bridgeSafeDelegate: {
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
  };
} {
  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp",
      sessionStore: baseStore,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "openclaw" ? "openclaw acp" : agentName),
        list: () => ["codex", "openclaw"],
      },
      permissionMode: "approve-reads",
      ...options,
    },
    testOptions,
  );

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
          cancel: AcpRuntime["cancel"];
          close: AcpRuntime["close"];
          ensureSession: AcpRuntime["ensureSession"];
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
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
          setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
          isHealthy(): boolean;
          probeAvailability(): Promise<void>;
        };
      }
    ).bridgeSafeDelegate,
  };
}

function makeLeaseStore() {
  const leases = new Map<string, Record<string, unknown>>();
  return {
    leases,
    store: {
      load: vi.fn(async (leaseId: string) => leases.get(leaseId) as never),
      listOpen: vi.fn(async () => Array.from(leases.values()) as never),
      save: vi.fn(async (lease: Record<string, unknown>) => {
        leases.set(String(lease.leaseId), lease);
      }),
      markState: vi.fn(async (leaseId: string, state: string) => {
        const lease = leases.get(leaseId);
        if (lease) {
          lease.state = state;
        }
      }),
    },
  };
}

function readFirstEnsureSessionInput(ensure: {
  mock: { calls: Array<Array<unknown>> };
}): Parameters<AcpRuntime["ensureSession"]>[0] {
  const [call] = ensure.mock.calls;
  if (!call) {
    throw new Error("Expected ensureSession to be called");
  }
  const [input] = call;
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected ensureSession to be called with an input object");
  }
  return input as Parameters<AcpRuntime["ensureSession"]>[0];
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unsupported runtime session modes with a clear AcpRuntimeError (issue #73071)", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const ensureSpy = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });

    for (const badMode of ["run", "session", "", undefined, null, 0]) {
      let error: unknown;
      try {
        await runtime.ensureSession({
          sessionKey: "agent:claude:acp:test",
          agent: "claude",
          mode: badMode as never,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(AcpRuntimeError);
      const acpError = error as AcpRuntimeError;
      expect(acpError.name).toBe("AcpRuntimeError");
      expect(acpError.code).toBe("ACP_INVALID_RUNTIME_OPTION");
      expect(acpError.message).toBe(
        `Unsupported ACP runtime session mode ${JSON.stringify(badMode)}. Expected one of: persistent, oneshot.`,
      );
    }

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("exposes assertSupportedRuntimeSessionMode as a typed guard", () => {
    expect(__testing.assertSupportedRuntimeSessionMode("persistent")).toBeUndefined();
    expect(__testing.assertSupportedRuntimeSessionMode("oneshot")).toBeUndefined();
    expect(() => __testing.assertSupportedRuntimeSessionMode("run" as never)).toThrow(
      AcpRuntimeError,
    );
  });

  it("normalizes OpenClaw Codex model ids for ACP startup", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? CODEX_ACP_COMMAND : agentName),
        list: () => ["codex", "openclaw"],
      },
    });
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "codex",
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "openai-codex/gpt-5.4",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "gpt-5.4",
    });
  });

  it("leaves Codex ACP startup defaults alone when no model or thinking is provided", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? CODEX_ACP_COMMAND : agentName),
        list: () => ["codex", "openclaw"],
      },
    });
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "codex",
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });

    const ensureInput = readFirstEnsureSessionInput(ensure);
    expect(ensureInput).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });
    expect(ensureInput).not.toHaveProperty("model");
    expect(ensureInput).not.toHaveProperty("thinking");
  });

  it("does not normalize model startup for non-Codex ACP agents", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "main" ? CODEX_ACP_COMMAND : agentName),
        list: () => ["main", "codex", "openclaw"],
      },
    });
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:main:acp:test",
      backend: "acpx",
      runtimeSessionName: "main",
    });

    await runtime.ensureSession({
      sessionKey: "agent:main:acp:test",
      agent: "main",
      mode: "persistent",
      model: "openai-codex/gpt-5.5",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:main:acp:test",
      agent: "main",
      mode: "persistent",
      model: "openai-codex/gpt-5.5",
    });
  });

  it("injects Codex ACP startup config into the scoped registry", () => {
    expect(__testing.isCodexAcpCommand(CODEX_ACP_COMMAND)).toBe(true);
    expect(__testing.isCodexAcpCommand(CODEX_ACP_WRAPPER_COMMAND)).toBe(true);
    expect(
      __testing.appendCodexAcpConfigOverrides(CODEX_ACP_COMMAND, {
        model: "gpt-5.4",
        reasoningEffort: "medium",
      }),
    ).toBe(
      "npx @zed-industries/codex-acp@0.13.0 -c model=gpt-5.4 -c model_reasoning_effort=medium",
    );
    expect(__testing.isCodexAcpCommand("openclaw acp")).toBe(false);
  });

  it("passes gpt-5.5 Codex ACP startup through instead of blocking it", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? CODEX_ACP_COMMAND : agentName),
        list: () => ["codex", "openclaw"],
      },
    });
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "codex",
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "openai-codex/gpt-5.5",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "gpt-5.5",
    });
  });

  it("maps explicit Codex ACP thinking to startup reasoning effort", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? CODEX_ACP_COMMAND : agentName),
        list: () => ["codex", "openclaw"],
      },
    });
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "codex",
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "openai-codex/gpt-5.4",
      thinking: "x-high",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "gpt-5.4/xhigh",
      thinking: "x-high",
    });
  });

  it("normalizes Codex ACP model config controls to adapter ids", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    const handle: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]["handle"] = {
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:test",
      acpxRecordId: "agent:codex:acp:test",
    };

    await runtime.setConfigOption({
      handle,
      key: "model",
      value: "openai-codex/gpt-5.4",
    });

    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "gpt-5.4",
    });
    expect(setConfigOption).toHaveBeenCalledOnce();
  });

  it("normalizes Codex ACP slash reasoning suffixes to config controls", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    const handle: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]["handle"] = {
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:test",
      acpxRecordId: "agent:codex:acp:test",
    };

    await runtime.setConfigOption({
      handle,
      key: "model",
      value: "openai-codex/gpt-5.4/high",
    });

    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "gpt-5.4",
    });
    expect(setConfigOption).toHaveBeenNthCalledWith(2, {
      handle,
      key: "reasoning_effort",
      value: "high",
    });
  });

  it("normalizes Codex ACP thinking config controls to reasoning effort", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    const handle: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]["handle"] = {
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:test",
      acpxRecordId: "agent:codex:acp:test",
    };

    await runtime.setConfigOption({
      handle,
      key: "thinking",
      value: "minimal",
    });

    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "reasoning_effort",
      value: "low",
    });
  });

  it("ignores unsupported Codex ACP timeout config controls", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    const handle: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]["handle"] = {
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:test",
      acpxRecordId: "agent:codex:acp:test",
    };

    await runtime.setConfigOption({
      handle,
      key: "timeout",
      value: "60000",
    });
    await runtime.setConfigOption({
      handle,
      key: "Timeout_Seconds",
      value: "60",
    });

    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("forwards timeout config controls for non-Codex ACP agents", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:claude:acp:test",
        agentCommand: "npx @agentclientprotocol/claude-agent-acp",
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    const handle: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]["handle"] = {
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:claude:acp:test",
      acpxRecordId: "agent:claude:acp:test",
    };

    await runtime.setConfigOption({
      handle,
      key: "timeout",
      value: "60",
    });

    expect(setConfigOption).toHaveBeenCalledOnce();
    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "timeout",
      value: "60",
    });
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

  it("cleans up OpenClaw-owned ACPX process trees after close", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        pid: 900,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 900,
              ppid: 1,
              command: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
            },
            {
              pid: 901,
              ppid: 900,
              command:
                "node /tmp/openclaw/plugin-runtime-deps/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
            },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed.slice(0, 2)).toEqual([
      { pid: 901, signal: "SIGTERM" },
      { pid: 900, signal: "SIGTERM" },
    ]);
  });

  it("records ACPX process leases without persisting lease-specific agent commands", async () => {
    const savedRecords: Record<string, unknown>[] = [];
    const launchCommands: string[] = [];
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async (record) => {
        savedRecords.push(record);
      }),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      const command = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
      launchCommands.push(command);
      await wrappedStore.save({
        name: input.sessionKey,
        agentCommand: command,
        pid: 777,
      });
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(leaseStore.store.save).toHaveBeenCalledTimes(2);
    const leases = Array.from(leaseStore.leases.values());
    expect(leases).toHaveLength(1);
    const lease = leases[0];
    expect(lease?.gatewayInstanceId).toBe("gateway-test");
    expect(lease?.sessionKey).toBe("agent:codex:acp:binding:test");
    expect(lease?.rootPid).toBe(777);
    expect(lease?.state).toBe("open");
    expect(lease?.wrapperPath).toBe("/tmp/openclaw/acpx/codex-acp-wrapper.mjs");
    expect(launchCommands[0]).toContain("OPENCLAW_ACPX_LEASE_ID=");
    expect(launchCommands[0]).toContain("OPENCLAW_GATEWAY_INSTANCE_ID=gateway-test");
    expect(savedRecords[0]?.agentCommand).toBe(CODEX_ACP_WRAPPER_COMMAND);
    expect(savedRecords[0]?.openclawGatewayInstanceId).toBe("gateway-test");
    expect(savedRecords[0]?.openclawLeaseId).toBe(lease?.leaseId);
  });

  it("keeps reusable persistent ACP launch commands stable across ensures", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        acpxRecordId: "record-1",
        acpSessionId: "session-1",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        cwd: "/tmp",
        closed: false,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    const resolvedCommands: string[] = [];
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      resolvedCommands.push(
        (
          runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
        ).scopedAgentRegistry.resolve("codex"),
      );
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(resolvedCommands).toEqual([CODEX_ACP_WRAPPER_COMMAND]);
    expect(leaseStore.store.save).not.toHaveBeenCalled();
  });

  it("merges sidecar lease ids into loaded ACPX session records", async () => {
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-loaded", {
      leaseId: "lease-loaded",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 777,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const { wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });

    const loadedRecord = await wrappedStore.load("agent:codex:acp:binding:test");
    expect(loadedRecord?.openclawGatewayInstanceId).toBe("gateway-test");
    expect(loadedRecord?.openclawLeaseId).toBe("lease-loaded");
  });

  it("merges the lease for the current ACPX session process when old leases exist", async () => {
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-old", {
      leaseId: "lease-old",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 700,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    leaseStore.leases.set("lease-current", {
      leaseId: "lease-current",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 777,
      commandHash: "hash",
      startedAt: 2,
      state: "open",
    });
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const { wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });

    const loadedRecord = await wrappedStore.load("agent:codex:acp:binding:test");
    expect(loadedRecord?.openclawGatewayInstanceId).toBe("gateway-test");
    expect(loadedRecord?.openclawLeaseId).toBe("lease-current");
  });

  it("uses matching leases before legacy pid cleanup on close", async () => {
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-close", {
      leaseId: "lease-close",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 930,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        openclawLeaseId: "lease-close",
        pid: 930,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 930,
              ppid: 1,
              command: CODEX_ACP_WRAPPER_COMMAND_WITH_LEASE,
            },
            { pid: 931, ppid: 930, command: "node child.js" },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed.slice(0, 2)).toEqual([
      { pid: 931, signal: "SIGTERM" },
      { pid: 930, signal: "SIGTERM" },
    ]);
    expect(leaseStore.store.markState).toHaveBeenCalledWith("lease-close", "closing");
    expect(leaseStore.store.markState).toHaveBeenLastCalledWith("lease-close", "closed");
  });

  it("closes the current process lease when the saved lease id is stale", async () => {
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-old", {
      leaseId: "lease-old",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 930,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    leaseStore.leases.set("lease-current", {
      leaseId: "lease-current",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 940,
      commandHash: "hash",
      startedAt: 2,
      state: "open",
    });
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        openclawLeaseId: "lease-old",
        pid: 940,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 930,
              ppid: 1,
              command: `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-old ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`,
            },
            {
              pid: 940,
              ppid: 1,
              command: `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-current ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`,
            },
            { pid: 941, ppid: 940, command: "node child.js" },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed.slice(0, 2)).toEqual([
      { pid: 941, signal: "SIGTERM" },
      { pid: 940, signal: "SIGTERM" },
    ]);
    expect(leaseStore.store.markState.mock.calls).toEqual([
      ["lease-current", "closing"],
      ["lease-current", "closed"],
    ]);
  });

  it("does not clean up a stale close pid reused by another wrapper root", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        pid: 920,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 920,
              ppid: 1,
              command: 'node "/tmp/other-gateway/acpx/codex-acp-wrapper.mjs"',
            },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed).toStrictEqual([]);
  });

  it("does not tear down reusable ACPX sessions after cancel", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        processId: "910",
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const listProcesses = vi.fn(async () => {
      throw new Error("process listing should not run on cancel");
    });
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {},
      {
        openclawProcessCleanup: {
          listProcesses,
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    const cancel = vi.spyOn(delegate, "cancel").mockResolvedValue(undefined);

    const input = {
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
    } satisfies Parameters<AcpRuntime["cancel"]>[0];

    await runtime.cancel(input);

    expect(cancel).toHaveBeenCalledWith(input);
    expect(listProcesses).not.toHaveBeenCalled();
    expect(killed).toStrictEqual([]);
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
