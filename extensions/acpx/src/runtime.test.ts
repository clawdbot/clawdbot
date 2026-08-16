// ACPX tests cover runtime plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestedModelUnsupportedError } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeEvent,
  type AcpRuntimeTurn,
} from "../runtime-api.js";
import { OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import {
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
  readAcpxProcessLeaseIdentity,
} from "./process-lease.js";
import { AcpxRuntime, testing, type AcpSessionStore } from "./runtime.js";
import { ACPX_PROCESS_LEASE_MAX_ENTRIES } from "./state.js";

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

const DOCUMENTED_OPENCLAW_BRIDGE_COMMAND =
  "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main";
const CODEX_ACP_COMMAND = "npx @agentclientprotocol/codex-acp@1.6.0";
const CODEX_ACP_WRAPPER_COMMAND = `node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"`;
const CODEX_ACP_WRAPPER_COMMAND_WITH_LEASE = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
const LOCAL_NODE_MODULES_CODEX_COMMAND = `node "${path.resolve(
  "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
)}"`;

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
    startTurn: NonNullable<AcpRuntime["startTurn"]>;
    runTurn: AcpRuntime["runTurn"];
    getCapabilities: NonNullable<AcpRuntime["getCapabilities"]>;
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setMode: NonNullable<AcpRuntime["setMode"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
  };
  bridgeSafeDelegate: {
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
  };
} {
  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp",
      sessionStore: baseStore as unknown as AcpSessionStore,
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
          startTurn: NonNullable<AcpRuntime["startTurn"]>;
          runTurn: AcpRuntime["runTurn"];
          getCapabilities: NonNullable<AcpRuntime["getCapabilities"]>;
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          setMode: NonNullable<AcpRuntime["setMode"]>;
          setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
          isHealthy(): boolean;
          probeAvailability(): Promise<void>;
          doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
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
          doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
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
        if (state === "closed" || state === "lost") {
          leases.delete(leaseId);
          return;
        }
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

  it("advertises elicitation modes and forwards the exact handler through every delegate", async () => {
    const onElicitation = vi.fn(async () => ({ action: "cancel" as const }));
    const handle = (sessionKey: string) => ({
      sessionKey,
      backend: "acpx",
      runtimeSessionName: sessionKey,
      acpxRecordId: sessionKey,
    });
    const runThrough = async (runtime: AcpxRuntime, sessionKey: string) => {
      for await (const event of runtime.runTurn({
        handle: handle(sessionKey),
        text: "ask",
        mode: "prompt",
        requestId: `request:${sessionKey}`,
        onElicitation,
      })) {
        void event;
      }
    };
    const baseStore = (agentCommand: string): TestSessionStore => ({
      load: vi.fn(async (sessionId: string) => ({ acpxRecordId: sessionId, agentCommand })),
      save: vi.fn(async () => {}),
    });

    const defaultRuntime = makeRuntime(baseStore(CODEX_ACP_COMMAND), {
      elicitationModes: ["form", "url"],
    });
    const defaultTurn = vi
      .spyOn(defaultRuntime.delegate, "runTurn")
      .mockImplementation(async function* () {
        yield { type: "done" };
      });
    await runThrough(defaultRuntime.runtime, "agent:codex:acp:default");

    const bridgeRuntime = makeRuntime(baseStore(DOCUMENTED_OPENCLAW_BRIDGE_COMMAND), {
      elicitationModes: ["form", "url"],
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
    });
    const bridgeDelegate = bridgeRuntime.bridgeSafeDelegate as typeof bridgeRuntime.delegate;
    const bridgeTurn = vi.spyOn(bridgeDelegate, "runTurn").mockImplementation(async function* () {
      yield { type: "done" };
    });
    await runThrough(bridgeRuntime.runtime, "agent:openclaw:acp:bridge");

    const managedRuntime = makeRuntime(baseStore(CODEX_ACP_COMMAND), {
      elicitationModes: ["form", "url"],
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [{ name: "openclaw-tools", command: "node", args: [], env: [] }],
    });
    const managedDelegate = (
      managedRuntime.runtime as unknown as {
        resolveManagedToolsDelegateForSession(sessionKey: string): typeof managedRuntime.delegate;
      }
    ).resolveManagedToolsDelegateForSession("agent:codex:acp:managed");
    const managedTurn = vi.spyOn(managedDelegate, "runTurn").mockImplementation(async function* () {
      yield { type: "done" };
    });
    await runThrough(managedRuntime.runtime, "agent:codex:acp:managed");

    for (const turn of [defaultTurn, bridgeTurn, managedTurn]) {
      expect(turn).toHaveBeenCalledOnce();
      expect(turn.mock.calls[0]?.[0].onElicitation).toBe(onElicitation);
    }
    for (const delegate of [defaultRuntime.delegate, bridgeDelegate, managedDelegate] as Array<{
      options?: { elicitationModes?: readonly string[] };
    }>) {
      expect(delegate.options?.elicitationModes).toEqual(["form", "url"]);
    }
  });

  it("adds the OpenClaw session key to both managed tools MCP bridges", () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime } = makeRuntime(baseStore, {
      pluginToolsMcpBridgeEnabled: true,
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [
        {
          name: "openclaw-plugin-tools",
          command: "node",
          args: ["dist/mcp/plugin-tools-serve.js"],
          env: [],
        },
        {
          name: "openclaw-tools",
          command: "node",
          args: ["dist/mcp/openclaw-tools-serve.js"],
          env: [],
        },
      ],
    });

    const readScopedMcpEnv = (sessionKey: string, serverName: string) => {
      const delegate = (
        runtime as unknown as {
          resolveManagedToolsDelegateForSession(sessionKey: string): unknown;
        }
      ).resolveManagedToolsDelegateForSession(sessionKey) as {
        options: {
          mcpServers?: Array<{
            env?: Array<{ name: string; value: string }>;
            name: string;
          }>;
        };
      };
      return delegate.options.mcpServers?.find((server) => server.name === serverName)?.env;
    };

    expect(readScopedMcpEnv("agent:worker:main", "openclaw-plugin-tools")).toContainEqual({
      name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY",
      value: "agent:worker:main",
    });
    expect(readScopedMcpEnv("agent:research:main", "openclaw-tools")).toContainEqual({
      name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY",
      value: "agent:research:main",
    });
  });

  it("keeps managed OpenClaw tools MCP delegates reachable for fresh sessions", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime } = makeRuntime(baseStore, {
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [
        {
          name: "openclaw-tools",
          command: "node",
          args: ["dist/mcp/openclaw-tools-serve.js"],
          env: [],
        },
      ],
    });
    const exposedRuntime = runtime as unknown as {
      managedToolsSessionDelegates: Map<string, unknown>;
      resolveManagedToolsDelegateForSession(sessionKey: string): unknown;
    };

    const firstDelegate = exposedRuntime.resolveManagedToolsDelegateForSession("agent:worker:main");
    expect(exposedRuntime.managedToolsSessionDelegates.has("agent:worker:main")).toBe(true);

    await runtime.prepareFreshSession({ sessionKey: "agent:worker:main" });

    expect(exposedRuntime.managedToolsSessionDelegates.has("agent:worker:main")).toBe(true);
    expect(exposedRuntime.resolveManagedToolsDelegateForSession("agent:worker:main")).toBe(
      firstDelegate,
    );
  });

  it("uses the no-MCP delegate for startup probes when the OpenClaw tools bridge is enabled", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate, bridgeSafeDelegate } = makeRuntime(baseStore, {
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [
        {
          name: "openclaw-tools",
          command: "node",
          args: ["dist/mcp/openclaw-tools-serve.js"],
          env: [],
        },
      ],
    });
    const defaultProbe = vi.spyOn(delegate, "probeAvailability").mockResolvedValue(undefined);
    const safeProbe = vi
      .spyOn(bridgeSafeDelegate, "probeAvailability")
      .mockResolvedValue(undefined);

    await runtime.probeAvailability();

    expect(safeProbe).toHaveBeenCalledTimes(1);
    expect(defaultProbe).not.toHaveBeenCalled();
  });

  it("leases generated-wrapper probes before delegate entry and retains absent wrappers", async () => {
    const events: string[] = [];
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.store.save.mockImplementation(async (lease: Record<string, unknown>) => {
      events.push("lease-saved");
      leaseStore.leases.set(String(lease.leaseId), lease);
    });
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => {
            events.push("process-inspected");
            return [];
          }),
        },
      },
    );
    let launchedCommand = "";
    vi.spyOn(delegate, "probeAvailability").mockImplementation(async () => {
      events.push("probe-entered");
      launchedCommand = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
    });

    await runtime.probeAvailability();

    expect(events).toEqual(["lease-saved", "probe-entered", "process-inspected"]);
    expect(launchedCommand).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
    expect(launchedCommand).toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`);
    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ rootPid: 0, state: "open" }),
    ]);
    expect(leaseStore.store.markState).not.toHaveBeenCalledWith(expect.any(String), "lost");
  });

  it("reaps a fulfilled probe wrapper that exact live evidence still finds", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    let launchedCommand = "";
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            { pid: 710, ppid: 1, command: launchedCommand },
            { pid: 711, ppid: 710, command: "node adapter-child.js" },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "probeAvailability").mockImplementation(async () => {
      launchedCommand = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
    });

    await runtime.probeAvailability();

    expect(killed.slice(0, 2)).toEqual([
      { pid: 711, signal: "SIGTERM" },
      { pid: 710, signal: "SIGTERM" },
    ]);
    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ rootPid: 0, state: "open" }),
    ]);
  });

  it("retains a fulfilled probe lease when live evidence is unavailable", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => {
            throw new Error("process evidence unavailable");
          }),
        },
      },
    );
    vi.spyOn(delegate, "probeAvailability").mockResolvedValue(undefined);

    await runtime.probeAvailability();

    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ rootPid: 0, state: "open" }),
    ]);
  });

  it("coalesces repeated probe uncertainty before it can evict a live lease", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-live", {
      leaseId: "lease-live",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:live",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 700,
      commandHash: "hash-live",
      startedAt: 1,
      state: "open",
    });
    leaseStore.store.save.mockImplementation(async (lease: Record<string, unknown>) => {
      const leaseId = String(lease.leaseId);
      leaseStore.leases.delete(leaseId);
      leaseStore.leases.set(leaseId, lease);
      if (leaseStore.leases.size > ACPX_PROCESS_LEASE_MAX_ENTRIES) {
        const oldestLeaseId = leaseStore.leases.keys().next().value;
        if (oldestLeaseId) {
          leaseStore.leases.delete(oldestLeaseId);
        }
      }
    });
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => []),
        },
      },
    );
    const probeLeaseIds = new Set<string>();
    vi.spyOn(delegate, "probeAvailability").mockImplementation(async () => {
      const command = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
      const identity = readAcpxProcessLeaseIdentity(command);
      expect(identity).toBeDefined();
      probeLeaseIds.add(String(identity?.leaseId));
    });

    for (let index = 0; index <= ACPX_PROCESS_LEASE_MAX_ENTRIES; index += 1) {
      await runtime.probeAvailability();
    }

    const { runtime: updatedRuntime, delegate: updatedDelegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? `${CODEX_ACP_WRAPPER_COMMAND} --updated` : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => []),
        },
      },
    );
    vi.spyOn(updatedDelegate, "probeAvailability").mockImplementation(async () => {
      const command = (
        updatedRuntime as unknown as {
          scopedAgentRegistry: { resolve(agent: string): string };
        }
      ).scopedAgentRegistry.resolve("codex");
      const identity = readAcpxProcessLeaseIdentity(command);
      expect(identity).toBeDefined();
      probeLeaseIds.add(String(identity?.leaseId));
    });
    await updatedRuntime.probeAvailability();

    expect(leaseStore.leases.has("lease-live")).toBe(true);
    expect(leaseStore.leases.size).toBe(2);
    expect(probeLeaseIds.size).toBe(1);
  });

  it("leases generated-wrapper doctor probes and keeps uncertain failures open", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
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
    vi.spyOn(delegate, "doctor").mockImplementation(async () => {
      const command = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
      expect(command).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
      throw new Error("probe launch state unknown");
    });

    await expect(runtime.doctor()).rejects.toThrow("probe launch state unknown");

    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({
        gatewayInstanceId: "gateway-test",
        rootPid: 0,
        sessionKey: "openclaw:acpx:probe",
        state: "open",
      }),
    ]);
    expect(leaseStore.store.markState).not.toHaveBeenCalledWith(expect.any(String), "lost");
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
      model: "openai/gpt-5.4",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "gpt-5.4",
      sessionOptions: { model: "gpt-5.4" },
    });
  });

  it.each([
    {
      name: "strips the OpenClaw Anthropic provider prefix for Claude ACP startup",
      model: "anthropic/claude-sonnet-4-6",
      expectedModel: "claude-sonnet-4-6",
    },
    {
      name: "preserves custom Claude ACP startup models",
      model: "custom-model",
      expectedModel: "custom-model",
    },
    {
      // Issue #121034: Bedrock rejects provider-qualified refs.
      name: "strips the OpenClaw Bedrock provider prefix for Claude ACP startup",
      model: "amazon-bedrock/global.anthropic.claude-sonnet-5",
      expectedModel: "global.anthropic.claude-sonnet-5",
    },
    {
      name: "matches the Bedrock provider prefix case-insensitively",
      model: "Amazon-Bedrock/us.anthropic.claude-opus-4-6-v1",
      expectedModel: "us.anthropic.claude-opus-4-6-v1",
    },
    {
      // Bare inference-profile ids and ARNs are native Bedrock values the SDK
      // accepts as-is; only the documented OpenClaw prefixes may be stripped.
      name: "preserves native Bedrock inference-profile ids",
      model: "global.anthropic.claude-sonnet-5",
      expectedModel: "global.anthropic.claude-sonnet-5",
    },
    {
      name: "preserves Bedrock inference-profile ARNs",
      model:
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5",
      expectedModel:
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5",
    },
  ])("$name", async ({ model, expectedModel }) => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "claude" ? "npx @agentclientprotocol/claude-agent-acp" : agentName,
        list: () => ["claude", "openclaw"],
      },
    });
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });

    await runtime.ensureSession({
      sessionKey: "agent:claude:acp:test",
      agent: "claude",
      mode: "persistent",
      model,
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:claude:acp:test",
      agent: "claude",
      mode: "persistent",
      model: expectedModel,
      sessionOptions: { model: expectedModel },
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

  it.each([
    {
      name: "adds the redacted Codex wrapper stderr tail to session initialization failures",
      stderr:
        "noise\nUnhandled error during session/new: deployment missing token=[REDACTED] sk-testsecret1234567890\n",
      expectedFragment: "deployment missing",
      forbiddenFragment: "sk-testsecret1234567890",
    },
    {
      name: "keeps the 6,000-unit Codex wrapper stderr tail UTF-16 safe",
      stderr: `🚀${"a".repeat(5_999)}`,
      expectedFragment: `Internal error: ${"a".repeat(5_999)}`,
      forbiddenFragment: "\ude80",
    },
  ])("$name", async ({ stderr, expectedFragment, forbiddenFragment }) => {
    const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
    const leaseStore = makeLeaseStore();
    const wrapperCommand = `node "${path.join(wrapperRoot, "codex-acp-wrapper.mjs")}"`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: wrapperRoot,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? wrapperCommand : agentName),
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      const leaseId = String(Array.from(leaseStore.leases.values())[0]?.leaseId);
      await fs.writeFile(
        path.join(wrapperRoot, `codex-acp-wrapper.stderr.${leaseId}.log`),
        stderr,
        "utf8",
      );
      throw new Error("Internal error");
    });

    const outcome = await runtime
      .ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "oneshot",
      })
      .then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    expect(outcome.error).toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining(expectedFragment),
    });
    const error = outcome.error;
    expect(error).toBeInstanceOf(AcpRuntimeError);
    if (!(error instanceof AcpRuntimeError)) {
      throw new Error("expected AcpRuntimeError");
    }
    expect(error.message).not.toContain(forbiddenFragment);
  });

  it("adds Codex wrapper stderr tail to generic first-turn failures", async () => {
    const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
    await fs.writeFile(
      path.join(wrapperRoot, "codex-acp-wrapper.stderr.lease-turn.log"),
      "Unhandled error during turn: upstream model returned 404\n",
      "utf8",
    );
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        openclawLeaseId: "lease-turn",
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawWrapperRoot: wrapperRoot,
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      const emptyAsyncIterable: AsyncIterable<never> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined as never }),
        }),
      };
      yield* emptyAsyncIterable;
      throw new Error("Internal error");
    });

    await expect(async () => {
      for await (const ignoredEventValue of runtime.runTurn({
        handle: {
          sessionKey: "agent:codex:acp:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:test",
          acpxRecordId: "agent:codex:acp:test",
        },
        text: "Reply exactly OK",
        mode: "prompt",
        requestId: "turn-1",
      })) {
        void ignoredEventValue;
        // no-op
      }
    }).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_TURN_FAILED",
      message: expect.stringContaining("upstream model returned 404"),
    });
  });

  it("adds Codex wrapper stderr tail to generic terminal turn error events", async () => {
    const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
    await fs.writeFile(
      path.join(wrapperRoot, "codex-acp-wrapper.stderr.lease-turn-event.log"),
      "Unhandled error during turn: profile missing OPENAI_API_KEY\n",
      "utf8",
    );
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        openclawLeaseId: "lease-turn-event",
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawWrapperRoot: wrapperRoot,
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      yield {
        type: "error",
        message: "Internal error",
        retryable: false,
      };
    });

    const events: AcpRuntimeEvent[] = [];
    for await (const event of runtime.runTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
        acpxRecordId: "agent:codex:acp:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "error",
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("profile missing OPENAI_API_KEY"),
        retryable: false,
      },
    ]);
  });

  it("adds Codex wrapper stderr tail to generic startTurn failure results", async () => {
    const promptStarted = createDeferred<void>();
    const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
    await fs.writeFile(
      path.join(wrapperRoot, "codex-acp-wrapper.stderr.lease-start-turn.log"),
      "Unhandled error during turn: adapter disconnected after progress\n",
      "utf8",
    );
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        openclawLeaseId: "lease-start-turn",
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawWrapperRoot: wrapperRoot,
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "startTurn").mockImplementation((input): AcpRuntimeTurn => {
      return {
        requestId: input.requestId,
        promptStarted: promptStarted.promise,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "Vou mapear o fluxo real primeiro...",
          };
        })(),
        result: Promise.resolve({
          status: "failed" as const,
          error: {
            message: "Internal error",
            retryable: false,
          },
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      };
    });

    const turn = runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
        acpxRecordId: "agent:codex:acp:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-1",
    });
    expect(turn.promptStarted).toBeDefined();
    let submitted = false;
    const observedPromptStarted = turn.promptStarted.then(() => {
      submitted = true;
    });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(submitted).toBe(false);
    promptStarted.resolve();
    await observedPromptStarted;
    expect(submitted).toBe(true);

    await expect(turn.result).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("adapter disconnected after progress"),
        retryable: false,
      },
    });
    expect(events).toEqual([
      {
        type: "text_delta",
        stream: "output",
        text: "Vou mapear o fluxo real primeiro...",
      },
    ]);
  });

  it("adds Codex wrapper stderr tail when startTurn creation throws", async () => {
    const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
    await fs.writeFile(
      path.join(wrapperRoot, "codex-acp-wrapper.stderr.lease-start-turn-create.log"),
      "Unhandled error during turn: adapter failed before returning turn\n",
      "utf8",
    );
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        openclawLeaseId: "lease-start-turn-create",
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawWrapperRoot: wrapperRoot,
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "startTurn").mockImplementation(() => {
      throw new Error("Internal error");
    });

    const turn = runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
        acpxRecordId: "agent:codex:acp:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-1",
    });

    const promptStarted = turn.promptStarted;
    expect(promptStarted).toBeDefined();
    await expect(promptStarted).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_TURN_FAILED",
      message: expect.stringContaining("adapter failed before returning turn"),
    });
    await expect(turn.result).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_TURN_FAILED",
      message: expect.stringContaining("adapter failed before returning turn"),
    });
  });

  it("disables delegate prompt timeout for OpenClaw-managed turns", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      timeoutMs: 1,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? CODEX_ACP_COMMAND : agentName),
        list: () => ["codex"],
      },
    });
    const runTurn = vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      yield { type: "done" };
    });
    const startTurn = vi
      .spyOn(delegate, "startTurn")
      .mockImplementation((input): AcpRuntimeTurn => {
        return {
          requestId: input.requestId,
          promptStarted: Promise.resolve(),
          events: (async function* () {
            yield { type: "done" as const, stopReason: "end_turn" };
          })(),
          result: Promise.resolve({
            status: "completed" as const,
            stopReason: "end_turn",
          }),
          cancel: vi.fn(async () => {}),
          closeStream: vi.fn(async () => {}),
        };
      });

    for await (const ignoredEventValue of runtime.runTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
        acpxRecordId: "agent:codex:acp:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-1",
    })) {
      void ignoredEventValue;
      // no-op
    }

    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 0,
      }),
    );

    const turn = runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
        acpxRecordId: "agent:codex:acp:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-2",
    });
    for await (const ignoredEventValue of turn.events) {
      void ignoredEventValue;
      // no-op
    }
    await turn.result;

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 0,
      }),
    );
  });

  it("passes model startup through sessionOptions for non-Codex ACP agents", async () => {
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
      model: "openai/gpt-5.5",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:main:acp:test",
      agent: "main",
      mode: "persistent",
      model: "openai/gpt-5.5",
      sessionOptions: { model: "openai/gpt-5.5" },
    });
  });

  it("retries without a model when ACPX reports missing model capability", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "opencode" ? "opencode acp" : agentName),
        list: () => ["opencode"],
      },
    });
    const ensure = vi
      .spyOn(delegate, "ensureSession")
      .mockRejectedValueOnce(
        new RequestedModelUnsupportedError(
          "Cannot apply --model: the ACP agent did not advertise model support",
          "missing-capability",
        ),
      )
      .mockResolvedValueOnce({
        sessionKey: "agent:opencode:acp:test",
        backend: "acpx",
        runtimeSessionName: "opencode",
      });

    await runtime.ensureSession({
      sessionKey: "agent:opencode:acp:test",
      agent: "opencode",
      mode: "persistent",
      model: "openrouter/owl-alpha",
    });

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(readFirstEnsureSessionInput(ensure)).toMatchObject({
      model: "openrouter/owl-alpha",
      sessionOptions: { model: "openrouter/owl-alpha" },
    });
    const [, secondCall] = ensure.mock.calls;
    expect(secondCall?.[0]).not.toHaveProperty("sessionOptions");
    expect((secondCall?.[0] as { model?: string } | undefined)?.model).toBeUndefined();
  });

  it("does not retry when ACPX rejects an explicitly unsupported model id", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "opencode" ? "opencode acp" : agentName),
        list: () => ["opencode"],
      },
    });
    const ensure = vi
      .spyOn(delegate, "ensureSession")
      .mockRejectedValueOnce(
        new RequestedModelUnsupportedError(
          "Cannot apply --model: the ACP agent did not advertise that model",
          "unadvertised-model",
        ),
      );

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:opencode:acp:test",
        agent: "opencode",
        mode: "persistent",
        model: "unknown/model",
      }),
    ).rejects.toThrow("did not advertise that model");
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unrelated error with similar wording", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const ensure = vi
      .spyOn(delegate, "ensureSession")
      .mockRejectedValueOnce(new Error("the ACP agent did not advertise model support"));

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:main:acp:test",
        agent: "main",
        mode: "persistent",
        model: "openrouter/owl-alpha",
      }),
    ).rejects.toThrow("did not advertise model support");
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("injects Codex ACP startup config into the scoped registry", () => {
    expect(testing.isCodexAcpCommand(CODEX_ACP_COMMAND)).toBe(true);
    expect(testing.isCodexAcpCommand(CODEX_ACP_WRAPPER_COMMAND)).toBe(true);
    expect(
      testing.appendCodexAcpConfigOverrides(CODEX_ACP_COMMAND, {
        model: "gpt-5.4",
        reasoningEffort: "medium",
      }),
    ).toBe(
      `npx @agentclientprotocol/codex-acp@1.6.0 ${OPENCLAW_CODEX_CONFIG_ARG} '{"model":"gpt-5.4","model_reasoning_effort":"medium"}'`,
    );
    expect(testing.isCodexAcpCommand("openclaw acp")).toBe(false);
    expect(testing.normalizeAgentCommand(["node", "/tmp/codex acp/index.js", "--label", ""])).toBe(
      "node '/tmp/codex acp/index.js' --label ''",
    );
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
      model: "openai/gpt-5.5",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "gpt-5.5",
      sessionOptions: { model: "gpt-5.5" },
    });
  });

  it("passes gpt-5.6-sol and medium as separate Codex ACP startup controls", async () => {
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
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
    });

    const ensureInput = readFirstEnsureSessionInput(ensure);
    expect(ensureInput).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "gpt-5.6-sol",
      thinking: "medium",
      sessionOptions: { model: "gpt-5.6-sol" },
    });
    expect(JSON.stringify(ensureInput)).not.toContain("gpt-5.6-sol/medium");
    expect(
      testing.appendCodexAcpConfigOverrides(CODEX_ACP_WRAPPER_COMMAND, {
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      }),
    ).not.toContain("gpt-5.6-sol/medium");
  });

  it("starts Codex ACP without injecting a leaked non-openai default model", async () => {
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
      model: "google/gemini-3.1-flash-lite",
    });

    const ensureInput = readFirstEnsureSessionInput(ensure);
    expect(ensureInput).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });
    expect(ensureInput).not.toHaveProperty("model");
    expect(ensureInput).not.toHaveProperty("sessionOptions");
  });

  it("reports a dropped leaked non-openai default on the returned handle", async () => {
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
    vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "codex",
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "google/gemini-3.1-flash-lite",
    });

    expect(handle.appliedModel).toEqual({ kind: "dropped" });
  });

  it("reports a supported codex model as applied on the returned handle", async () => {
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
    vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "codex",
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model: "openai/gpt-5.5",
    });

    expect(handle.appliedModel).toEqual({ kind: "applied", model: "openai/gpt-5.5" });
  });

  it("applies explicit Codex ACP thinking while dropping a leaked non-openai default model", async () => {
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
      model: "google/gemini-3.1-flash-lite",
      thinking: "low",
    });

    const ensureInput = readFirstEnsureSessionInput(ensure);
    expect(ensureInput).not.toHaveProperty("model");
    expect(ensureInput).not.toHaveProperty("sessionOptions");
    expect(ensureInput).toMatchObject({ thinking: "low" });
  });

  it("drops a leaked malformed Codex ACP default at spawn instead of failing the session", async () => {
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
      model: "gpt-5.4/ultra",
    });

    const ensureInput = readFirstEnsureSessionInput(ensure);
    expect(ensureInput).not.toHaveProperty("model");
    expect(ensureInput).not.toHaveProperty("sessionOptions");
  });

  it.each(["google/gemini-3.1-flash-lite", "gpt-5.4/ultra"])(
    "fails closed on an explicit unsupported Codex ACP spawn model %s without calling the delegate",
    async (model) => {
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

      await expect(
        runtime.ensureSession({
          sessionKey: "agent:codex:acp:test",
          agent: "codex",
          mode: "persistent",
          model,
          modelExplicit: true,
        }),
      ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it("passes an explicit supported Codex ACP spawn model through without leaking the provenance flag", async () => {
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
      model: "openai/gpt-5.5",
      modelExplicit: true,
    });

    const ensureInput = readFirstEnsureSessionInput(ensure);
    expect(ensureInput).not.toHaveProperty("modelExplicit");
    expect(ensureInput).toMatchObject({
      model: "gpt-5.5",
      sessionOptions: { model: "gpt-5.5" },
    });
  });

  it.each([
    {
      name: "normalizes OpenClaw-qualified Codex ACP model controls",
      value: "openai/gpt-5.4",
    },
    { name: "passes bare Codex ACP model controls through", value: "gpt-5.4" },
  ])("$name", async ({ value }) => {
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
      value,
    });

    expect(setConfigOption).toHaveBeenCalledOnce();
    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "model",
      value: "gpt-5.4",
    });
  });

  it.each([
    "google/gemini-3.1-flash-lite",
    "gpt-5.4/ultra",
    "openai/foo/bar",
    "openai/",
    "openai//high",
  ])("fails closed on Codex ACP model config control %s without re-injecting it", async (value) => {
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

    await expect(runtime.setConfigOption({ handle, key: "model", value })).rejects.toMatchObject({
      code: "ACP_INVALID_RUNTIME_OPTION",
    });
    expect(setConfigOption).not.toHaveBeenCalled();
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
      value: "openai/gpt-5.4/high",
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

  it("forwards getCapabilities input handles to the ACPX delegate", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const delegateCapabilities: AcpRuntimeCapabilities = {
      controls: ["session/set_config_option"],
      configOptionKeys: ["reasoning_effort", "model"],
    };
    const getCapabilities = vi
      .spyOn(delegate, "getCapabilities")
      .mockResolvedValue(delegateCapabilities);

    const handle: Parameters<NonNullable<AcpRuntime["getCapabilities"]>>[0]["handle"] = {
      sessionKey: "agent:codex:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:test",
      acpxRecordId: "agent:codex:acp:test",
    };
    const input = { handle };

    const result = await runtime.getCapabilities?.(input);

    expect(getCapabilities).toHaveBeenCalledWith(input);
    expect(result).toBe(delegateCapabilities);
  });

  it.each([
    {
      name: "normalizes Codex ACP thinking=minimal to reasoning effort",
      key: "thinking",
      value: "minimal",
      expected: "low",
    },
    {
      name: "normalizes Codex ACP reasoning_effort=x-high",
      key: "reasoning_effort",
      value: "x-high",
      expected: "xhigh",
    },
    {
      name: "rejects unsupported Codex ACP thinking controls",
      key: "thinking",
      value: "superhigh",
    },
    ...["thinking", "thought_level", "reasoning_effort"].map((key) => ({
      name: `rejects unsupported live Codex ACP ${key}=off`,
      key,
      value: "off",
      expected: undefined,
      errorCode: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    })),
  ])("$name", async (testCase) => {
    const { key, value, expected } = testCase;
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

    const update = runtime.setConfigOption({
      handle,
      key,
      value,
    });
    if (!expected) {
      await expect(update).rejects.toMatchObject({
        code: "errorCode" in testCase ? testCase.errorCode : "ACP_INVALID_RUNTIME_OPTION",
      });
      expect(setConfigOption).not.toHaveBeenCalled();
      return;
    }

    await update;
    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "reasoning_effort",
      value: expected,
    });
  });

  it("forwards unsupported thinking config rejection for non-Codex ACP sessions", async () => {
    const unsupportedThinkingError = new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      "unsupported thinking",
    );
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:gemini:acp:test",
        agentCommand: "gemini --experimental-acp",
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const setConfigOption = vi
      .spyOn(delegate, "setConfigOption")
      .mockRejectedValue(unsupportedThinkingError);
    const handle: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]["handle"] = {
      sessionKey: "agent:gemini:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:gemini:acp:test",
      acpxRecordId: "agent:gemini:acp:test",
    };

    await expect(
      runtime.setConfigOption({
        handle,
        key: "thinking",
        value: "high",
      }),
    ).rejects.toBe(unsupportedThinkingError);

    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "thinking",
      value: "high",
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

  it("ignores unsupported claude-agent-acp timeout config controls", async () => {
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
    await runtime.setConfigOption({
      handle,
      key: "Timeout_Seconds",
      value: "60",
    });

    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("normalizes model config controls for claude-agent-acp", async () => {
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
      key: "model",
      value: "anthropic/claude-sonnet-4-6",
    });
    await runtime.setConfigOption({
      handle,
      key: "model",
      value: "amazon-bedrock/global.anthropic.claude-sonnet-5",
    });

    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "claude-sonnet-4-6",
    });
    expect(setConfigOption).toHaveBeenNthCalledWith(2, {
      handle,
      key: "model",
      value: "global.anthropic.claude-sonnet-5",
    });
    expect(setConfigOption).toHaveBeenCalledTimes(2);
  });

  it("recognizes claude-agent-acp commands", () => {
    expect(testing.isClaudeAcpCommand("npx @agentclientprotocol/claude-agent-acp")).toBe(true);
    expect(testing.isClaudeAcpCommand("npx -y @agentclientprotocol/claude-agent-acp@0.33.1")).toBe(
      true,
    );
    expect(testing.isClaudeAcpCommand("claude-agent-acp")).toBe(true);
    expect(testing.isClaudeAcpCommand("claude-agent-acp.exe")).toBe(true);
    expect(
      testing.isClaudeAcpCommand(`node "/tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs"`),
    ).toBe(true);
    expect(
      testing.isClaudeAcpCommand(
        `node.exe "C:/Users/runner/AppData/Local/Temp/openclaw/acpx/claude-agent-acp-wrapper.mjs"`,
      ),
    ).toBe(true);
    expect(
      testing.isClaudeAcpCommand(
        `Node.EXE "C:/Users/runner/AppData/Local/Temp/openclaw/acpx/claude-agent-acp-wrapper.mjs"`,
      ),
    ).toBe(true);
    expect(testing.isClaudeAcpCommand("openclaw acp")).toBe(false);
    expect(testing.isClaudeAcpCommand("npx @agentclientprotocol/codex-acp")).toBe(false);
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
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: "agent:codex:acp:binding:test",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore["load"]).toHaveBeenCalledTimes(2);
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
    expect(baseStore["load"]).toHaveBeenCalledOnce();
  });

  it("releases managed OpenClaw tools MCP delegates after close", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    const { runtime } = makeRuntime(baseStore, {
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [
        {
          name: "openclaw-tools",
          command: "node",
          args: ["dist/mcp/openclaw-tools-serve.js"],
          env: [],
        },
      ],
    });
    const exposedRuntime = runtime as unknown as {
      managedToolsSessionDelegates: Map<string, { close: AcpRuntime["close"] }>;
      resolveManagedToolsDelegateForSession(sessionKey: string): {
        close: AcpRuntime["close"];
      };
    };
    const scopedDelegate = exposedRuntime.resolveManagedToolsDelegateForSession("agent:codex:main");
    const close = vi.spyOn(scopedDelegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:main",
        backend: "acpx",
        runtimeSessionName: "agent:codex:main",
      },
      reason: "closed",
    });

    expect(close).toHaveBeenCalledOnce();
    expect(exposedRuntime.managedToolsSessionDelegates.has("agent:codex:main")).toBe(false);
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
                "node /tmp/openclaw/plugin-runtime-deps/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
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

  it("persists ACPX process lease identity for later wrapper reconnects", async () => {
    const savedRecords: Record<string, unknown>[] = [];
    const launchCommands: string[] = [];
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecords.at(-1)),
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
    expect(launchCommands[0]).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
    expect(launchCommands[0]).toContain(OPENCLAW_GATEWAY_INSTANCE_ID_ARG);
    expect(savedRecords[0]?.agentCommand).toBe(launchCommands[0]);
    expect(savedRecords[0]?.openclawGatewayInstanceId).toBe("gateway-test");
    expect(savedRecords[0]?.openclawLeaseId).toBe(lease?.leaseId);
  });

  it("does not create launch leases for direct plugin-local ACP adapter commands", async () => {
    const launchCommands: string[] = [];
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? LOCAL_NODE_MODULES_CODEX_COMMAND : agentName,
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

    expect(leaseStore.store.save).not.toHaveBeenCalled();
    expect(launchCommands).toEqual([LOCAL_NODE_MODULES_CODEX_COMMAND]);
  });

  it("keeps reusable persistent ACP launch commands stable across ensures", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-existing ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        acpxRecordId: "record-1",
        acpSessionId: "session-1",
        agentCommand: leasedCommand,
        cwd: "/tmp",
        closed: false,
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-existing", {
      leaseId: "lease-existing",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 777,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
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

    expect(resolvedCommands).toEqual([leasedCommand]);
    expect(leaseStore.store.save).not.toHaveBeenCalled();
  });

  it("recreates a missing sidecar with the persisted lease identity", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-missing ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    let savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: leasedCommand,
      cwd: "/tmp",
      closed: false,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
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
      await wrappedStore.save({ ...savedRecord, agentCommand: command, pid: 777 });
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

    expect(savedRecord.agentCommand).toBe(leasedCommand);
    expect(leaseStore.leases.get("lease-missing")).toMatchObject({
      leaseId: "lease-missing",
      rootPid: 777,
    });
    expect(leaseStore.leases.size).toBe(1);
  });

  it("does not reuse commands leased by another gateway instance", async () => {
    const foreignCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-foreign ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-foreign`;
    let savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: foreignCommand,
      cwd: "/tmp",
      closed: false,
      pid: 777,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
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
    const resolvedCommands: string[] = [];
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      const command = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
      resolvedCommands.push(command);
      await wrappedStore.save({
        name: input.sessionKey,
        agentCommand: command,
        cwd: "/tmp",
        pid: 888,
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

    expect(resolvedCommands[0]).not.toBe(foreignCommand);
    expect(resolvedCommands[0]).toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`);
    expect(savedRecord.pid).toBe(888);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("rejects reconnect operations for commands leased by another gateway", async () => {
    const foreignCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-foreign-operation ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-foreign`;
    const handle = {
      sessionKey: "agent:codex:acp:binding:test",
      backend: "acpx" as const,
      runtimeSessionName: "agent:codex:acp:binding:test",
    };
    const expectedError = {
      code: "ACP_TURN_FAILED",
      message: "ACPX process lease lease-foreign-operation belongs to another gateway",
    };
    const createRuntime = () => {
      const baseStore: TestSessionStore = {
        load: vi.fn(async () => ({
          name: handle.sessionKey,
          agentCommand: foreignCommand,
        })),
        save: vi.fn(async () => {}),
      };
      const leaseStore = makeLeaseStore();
      const { runtime } = makeRuntime(baseStore, {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawToolsMcpBridgeEnabled: true,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        mcpServers: [
          {
            name: "openclaw-tools",
            command: "node",
            args: ["dist/mcp/openclaw-tools-serve.js"],
            env: [],
          },
        ],
      });
      const managedToolsSessionDelegates = (
        runtime as unknown as {
          managedToolsSessionDelegates: Map<string, unknown>;
        }
      ).managedToolsSessionDelegates;
      return { runtime, leaseStore, managedToolsSessionDelegates };
    };
    const expectRejectedWithoutDelegate = async (
      operation: (runtime: AcpxRuntime) => Promise<unknown>,
    ) => {
      const { runtime, leaseStore, managedToolsSessionDelegates } = createRuntime();
      await expect(operation(runtime)).rejects.toMatchObject(expectedError);
      expect(managedToolsSessionDelegates.has(handle.sessionKey)).toBe(false);
      expect(managedToolsSessionDelegates.size).toBe(0);
      expect(leaseStore.leases.size).toBe(0);
    };

    await expectRejectedWithoutDelegate((runtime) =>
      runtime.setConfigOption({ handle, key: "thinking", value: "minimal" }),
    );
    await expectRejectedWithoutDelegate((runtime) => runtime.setMode({ handle, mode: "plan" }));
    await expectRejectedWithoutDelegate((runtime) => runtime.close({ handle, reason: "done" }));

    const { runtime, leaseStore, managedToolsSessionDelegates } = createRuntime();
    const turn = runtime.startTurn({
      handle,
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "foreign-gateway",
    });
    const outcomes = await Promise.allSettled([turn.result, turn.cancel(), turn.closeStream()]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject(expectedError);
      }
    }
    expect(managedToolsSessionDelegates.has(handle.sessionKey)).toBe(false);
    expect(managedToolsSessionDelegates.size).toBe(0);
    expect(leaseStore.leases.size).toBe(0);
  });

  it("serializes concurrent persistent ensures for one session", async () => {
    let savedRecord: Record<string, unknown> | undefined;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
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
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let entered = 0;
    let active = 0;
    let maxActive = 0;
    const resolvedCommands: string[] = [];
    const ensure = vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      entered += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const command = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
      resolvedCommands.push(command);
      if (entered === 1) {
        await wrappedStore.save({
          name: input.sessionKey,
          acpSessionId: "session-1",
          agentCommand: command,
          cwd: "/tmp",
          pid: 777,
        });
        await firstBlocked;
      } else if (savedRecord) {
        await wrappedStore.save(savedRecord);
      }
      active -= 1;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });
    const ensureInput = {
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent" as const,
    };

    const first = runtime.ensureSession(ensureInput);
    while (ensure.mock.calls.length === 0) {
      await Promise.resolve();
    }
    const second = runtime.ensureSession(ensureInput);
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(resolvedCommands[1]).toBe(resolvedCommands[0]);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("adopts legacy persistent commands before their next reconnect", async () => {
    let savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: CODEX_ACP_WRAPPER_COMMAND,
      cwd: "/tmp",
      closed: false,
      pid: 777,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
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
    const resolvedCommands: string[] = [];
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      resolvedCommands.push(
        (
          runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
        ).scopedAgentRegistry.resolve("codex"),
      );
      await wrappedStore.save(savedRecord);
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
    expect(savedRecord.agentCommand).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
    expect(savedRecord.agentCommand).toContain(OPENCLAW_GATEWAY_INSTANCE_ID_ARG);
    expect(savedRecord.pid).toBeUndefined();
    expect(leaseStore.leases.size).toBe(0);

    await wrappedStore.save({ ...savedRecord, pid: 888 });

    const [lease] = Array.from(leaseStore.leases.values());
    expect(lease?.leaseId).toBe(savedRecord.openclawLeaseId);
    expect(lease?.rootPid).toBe(888);
  });

  it("keeps pending process leases when a fresh launch fails after spawn may have occurred", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
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
    vi.spyOn(delegate, "ensureSession").mockRejectedValue(new Error("launch failed"));

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:codex:acp:binding:test",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("launch failed");

    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ rootPid: 0, state: "open" }),
    ]);
    expect(leaseStore.store.markState).not.toHaveBeenCalledWith(expect.any(String), "lost");
  });

  it("preserves promoted process leases when session setup later fails", async () => {
    let savedRecord: Record<string, unknown> | undefined;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
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
      await wrappedStore.save({
        name: input.sessionKey,
        agentCommand: command,
        cwd: "/tmp",
        pid: 777,
      });
      throw new Error("setup failed after spawn");
    });

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:codex:acp:binding:test",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("setup failed after spawn");

    const [lease] = Array.from(leaseStore.leases.values());
    expect(lease?.rootPid).toBe(777);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("restores a pending process lease before runTurn reconnects", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-turn-reconnect ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      expect(leaseStore.leases.get("lease-turn-reconnect")).toMatchObject({
        rootPid: 0,
        sessionKey: "agent:codex:acp:binding:test",
      });
      yield { type: "status", text: "reconnecting" };
    });

    for await (const event of runtime.runTurn({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-reconnect",
    })) {
      void event;
    }
    expect(leaseStore.leases.size).toBe(0);
  });

  it("restores a missing sidecar from the persisted lease PID", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-live-reconnect ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      expect(leaseStore.leases.get("lease-live-reconnect")).toMatchObject({
        rootPid: 777,
        sessionKey: "agent:codex:acp:binding:test",
      });
      yield { type: "status", text: "connected" };
    });

    for await (const event of runtime.runTurn({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-live-reconnect",
    })) {
      void event;
    }

    expect(leaseStore.leases.get("lease-live-reconnect")).toMatchObject({
      rootPid: 777,
      state: "open",
    });
  });

  it("retires runTurn pending leases when handle resolution fails", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-turn-resolution ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    let loads = 0;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => {
        loads += 1;
        if (loads >= 2) {
          throw new Error("session load failed");
        }
        return {
          name: "agent:codex:acp:binding:test",
          agentCommand: leasedCommand,
        };
      }),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });

    await expect(async () => {
      for await (const event of runtime.runTurn({
        handle: {
          sessionKey: "agent:codex:acp:binding:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:binding:test",
        },
        text: "Reply exactly OK",
        mode: "prompt",
        requestId: "turn-resolution",
      })) {
        void event;
      }
    }).rejects.toThrow("session load failed");

    expect(leaseStore.leases.size).toBe(0);
  });

  it("restores a pending process lease before startTurn reconnects", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-start-reconnect ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "startTurn").mockImplementation((input) => {
      expect(leaseStore.leases.get("lease-start-reconnect")).toMatchObject({
        rootPid: 0,
        sessionKey: "agent:codex:acp:binding:test",
      });
      return {
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      };
    });

    const turn = runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "start-reconnect",
    });

    await expect(turn.result).resolves.toEqual({ status: "completed" });
    expect(leaseStore.leases.size).toBe(0);
  });

  it("loads one wrapper snapshot per handle operation before mutation", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-control-reconnect ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    const expectPendingLease = () => {
      expect(leaseStore.leases.get("lease-control-reconnect")).toMatchObject({
        rootPid: 0,
        sessionKey: "agent:codex:acp:binding:test",
      });
    };
    vi.spyOn(delegate, "startTurn").mockImplementation((input) => {
      expectPendingLease();
      return {
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      };
    });
    vi.spyOn(delegate, "setMode").mockImplementation(async () => expectPendingLease());
    const setConfigOption = vi
      .spyOn(delegate, "setConfigOption")
      .mockImplementation(async () => expectPendingLease());
    vi.spyOn(delegate, "close").mockImplementation(async () => expectPendingLease());
    const handle = {
      sessionKey: "agent:codex:acp:binding:test",
      backend: "acpx" as const,
      runtimeSessionName: "agent:codex:acp:binding:test",
    };
    const operations = [
      async () =>
        await runtime.startTurn({ handle, text: "OK", mode: "prompt", requestId: "1" }).result,
      async () => await runtime.setConfigOption({ handle, key: "thinking", value: "minimal" }),
      async () => await runtime.setMode({ handle, mode: "plan" }),
      async () => await runtime.close({ handle, reason: "done" }),
    ];

    for (const operation of operations) {
      vi.mocked(baseStore["load"]).mockClear();
      await operation();
      expect(baseStore["load"]).toHaveBeenCalledOnce();
      expect(leaseStore.leases.size).toBe(0);
    }

    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "reasoning_effort",
      value: "low",
    });
  });

  it("preserves a promoted PID when the session record save fails", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-partial-save ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      agentCommand: leasedCommand,
      pid: 777,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async () => {
        throw new Error("session save failed");
      }),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-partial-save", {
      leaseId: "lease-partial-save",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 777,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    const { runtime, delegate, wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "setMode").mockImplementation(async () => {
      await wrappedStore.save({ ...savedRecord, pid: 888 });
    });

    await expect(
      runtime.setMode({
        handle: {
          sessionKey: "agent:codex:acp:binding:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:binding:test",
        },
        mode: "plan",
      }),
    ).rejects.toThrow("session save failed");

    expect(leaseStore.leases.get("lease-partial-save")).toMatchObject({
      rootPid: 888,
      state: "open",
    });
  });

  it("keeps a shared pending lease until the last concurrent operation finishes", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-concurrent-operations ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    let markTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    let releaseTurn!: () => void;
    const turnBlocked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      markTurnStarted();
      await turnBlocked;
      yield { type: "status", text: "completed" };
    });
    vi.spyOn(delegate, "setMode").mockResolvedValue(undefined);
    const handle = {
      sessionKey: "agent:codex:acp:binding:test",
      backend: "acpx" as const,
      runtimeSessionName: "agent:codex:acp:binding:test",
    };
    const turn = (async () => {
      for await (const event of runtime.runTurn({
        handle,
        text: "Reply exactly OK",
        mode: "prompt",
        requestId: "turn-concurrent-operations",
      })) {
        void event;
      }
    })();
    await turnStarted;

    await runtime.setMode({ handle, mode: "plan" });

    expect(leaseStore.leases.get("lease-concurrent-operations")).toMatchObject({
      rootPid: 0,
    });
    releaseTurn();
    await turn;
    expect(leaseStore.leases.size).toBe(0);
  });

  it("retires an old lease after the session record switches identity", async () => {
    const oldCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-old-operation ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const newCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-new-session ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    let savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      agentCommand: oldCommand,
      pid: 777,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
      }),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-old-operation", {
      leaseId: "lease-old-operation",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 777,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    let markTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    let releaseTurn!: () => void;
    const turnBlocked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      markTurnStarted();
      await turnBlocked;
      yield { type: "status", text: "completed" };
    });
    const handle = {
      sessionKey: "agent:codex:acp:binding:test",
      backend: "acpx" as const,
      runtimeSessionName: "agent:codex:acp:binding:test",
    };
    const turn = (async () => {
      for await (const event of runtime.runTurn({
        handle,
        text: "Reply exactly OK",
        mode: "prompt",
        requestId: "turn-old-operation",
      })) {
        void event;
      }
    })();
    await turnStarted;

    savedRecord = {
      name: handle.sessionKey,
      agentCommand: newCommand,
      pid: 888,
    };
    releaseTurn();
    await turn;

    expect(leaseStore.leases.has("lease-old-operation")).toBe(false);
    expect(leaseStore.store.markState).toHaveBeenCalledWith("lease-old-operation", "lost");
  });

  it("keeps launch ownership while a concurrent reconnect operation is active", async () => {
    let savedRecord: Record<string, unknown> | undefined;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
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
    let markLaunchPersisted!: () => void;
    const launchPersisted = new Promise<void>((resolve) => {
      markLaunchPersisted = resolve;
    });
    let failLaunch!: () => void;
    const launchBlocked = new Promise<void>((resolve) => {
      failLaunch = resolve;
    });
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      const command = (
        runtime as unknown as { scopedAgentRegistry: { resolve(agent: string): string } }
      ).scopedAgentRegistry.resolve("codex");
      await wrappedStore.save({
        name: input.sessionKey,
        agentCommand: command,
        cwd: "/tmp",
      });
      markLaunchPersisted();
      await launchBlocked;
      throw new Error("launch failed");
    });
    let markControlStarted!: () => void;
    const controlStarted = new Promise<void>((resolve) => {
      markControlStarted = resolve;
    });
    let releaseControl!: () => void;
    const controlBlocked = new Promise<void>((resolve) => {
      releaseControl = resolve;
    });
    vi.spyOn(delegate, "setMode").mockImplementation(async () => {
      markControlStarted();
      await controlBlocked;
    });
    const sessionKey = "agent:codex:acp:binding:test";
    const handle = {
      sessionKey,
      backend: "acpx" as const,
      runtimeSessionName: sessionKey,
    };
    const launch = runtime.ensureSession({
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    await launchPersisted;
    const control = runtime.setMode({ handle, mode: "plan" });
    await controlStarted;

    failLaunch();
    await expect(launch).rejects.toThrow("launch failed");

    const leaseId = String(savedRecord?.openclawLeaseId);
    expect(leaseStore.leases.get(leaseId)).toMatchObject({
      leaseId,
      rootPid: 0,
    });
    releaseControl();
    await control;
    expect(leaseStore.leases.get(leaseId)).toMatchObject({ rootPid: 0, state: "open" });
  });

  it("serializes last-owner retirement with the next lease acquisition", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-retirement-race ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    let leaseLoads = 0;
    let markRetirementStarted!: () => void;
    const retirementStarted = new Promise<void>((resolve) => {
      markRetirementStarted = resolve;
    });
    let releaseRetirement!: () => void;
    const retirementBlocked = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    leaseStore.store.load.mockImplementation(async (leaseId: string) => {
      leaseLoads += 1;
      if (leaseLoads === 2) {
        markRetirementStarted();
        await retirementBlocked;
      }
      return leaseStore.leases.get(leaseId) as never;
    });
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      yield { type: "status", text: "completed" };
    });
    const setMode = vi.spyOn(delegate, "setMode").mockResolvedValue(undefined);
    const handle = {
      sessionKey: "agent:codex:acp:binding:test",
      backend: "acpx" as const,
      runtimeSessionName: "agent:codex:acp:binding:test",
    };
    const turn = (async () => {
      for await (const event of runtime.runTurn({
        handle,
        text: "Reply exactly OK",
        mode: "prompt",
        requestId: "turn-retirement-race",
      })) {
        void event;
      }
    })();
    await retirementStarted;

    const control = runtime.setMode({ handle, mode: "plan" });
    await Promise.resolve();
    expect(setMode).not.toHaveBeenCalled();
    releaseRetirement();

    await turn;
    await control;
    expect(setMode).toHaveBeenCalledTimes(1);
    expect(leaseStore.store.save).toHaveBeenCalledTimes(2);
    expect(leaseStore.leases.size).toBe(0);
  });

  it("rechecks a reusable sidecar after the prior owner retires it", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-reusable-race ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const sessionKey = "agent:codex:acp:binding:test";
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: sessionKey,
        acpSessionId: "session-1",
        agentCommand: leasedCommand,
        cwd: "/tmp",
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-reusable-race", {
      leaseId: "lease-reusable-race",
      gatewayInstanceId: "gateway-test",
      sessionKey,
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    let leaseLoads = 0;
    let markRetirementStarted!: () => void;
    const retirementStarted = new Promise<void>((resolve) => {
      markRetirementStarted = resolve;
    });
    let releaseRetirement!: () => void;
    const retirementBlocked = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    leaseStore.store.load.mockImplementation(async (leaseId: string) => {
      leaseLoads += 1;
      if (leaseLoads === 2) {
        markRetirementStarted();
        await retirementBlocked;
      }
      return leaseStore.leases.get(leaseId) as never;
    });
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
    vi.spyOn(delegate, "runTurn").mockImplementation(async function* () {
      yield { type: "status", text: "completed" };
    });
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      expect(leaseStore.leases.get("lease-reusable-race")).toMatchObject({
        rootPid: 0,
        sessionKey,
      });
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });
    const handle = {
      sessionKey,
      backend: "acpx" as const,
      runtimeSessionName: sessionKey,
    };
    const turn = (async () => {
      for await (const event of runtime.runTurn({
        handle,
        text: "Reply exactly OK",
        mode: "prompt",
        requestId: "turn-reusable-race",
      })) {
        void event;
      }
    })();
    await retirementStarted;

    const ensure = runtime.ensureSession({
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    releaseRetirement();

    await turn;
    await ensure;
    expect(leaseStore.store.save).toHaveBeenCalledTimes(1);
    expect(leaseStore.leases.size).toBe(0);
  });

  it("keeps close pending leases when cleanup fails", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close-failure ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    vi.spyOn(
      runtime as unknown as {
        cleanupProcessTreeForRecord: () => Promise<void>;
      },
      "cleanupProcessTreeForRecord",
    ).mockRejectedValue(new Error("cleanup failed"));

    await expect(
      runtime.close({
        handle: {
          sessionKey: "agent:codex:acp:binding:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:binding:test",
        },
        reason: "user-close",
      }),
    ).rejects.toThrow("cleanup failed");

    expect(leaseStore.leases.get("lease-close-failure")).toMatchObject({
      rootPid: 0,
      state: "open",
    });
  });

  it("preserves PID-bearing close leases when cleanup fails", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close-live ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-close-live", {
      leaseId: "lease-close-live",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 777,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    vi.spyOn(
      runtime as unknown as {
        cleanupProcessTreeForRecord: () => Promise<void>;
      },
      "cleanupProcessTreeForRecord",
    ).mockRejectedValue(new Error("cleanup failed"));

    await expect(
      runtime.close({
        handle: {
          sessionKey: "agent:codex:acp:binding:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:binding:test",
        },
        reason: "user-close",
      }),
    ).rejects.toThrow("cleanup failed");

    expect(leaseStore.leases.get("lease-close-live")).toMatchObject({
      rootPid: 777,
      state: "open",
    });
  });

  it.each([
    {
      evidence: "process listing is unavailable",
      processCleanup: {
        listProcesses: vi.fn(async () => {
          throw new Error("process listing unavailable");
        }),
      },
    },
    {
      evidence: "Windows process evidence is unsupported",
      processCleanup: {
        platform: "win32" as const,
        listProcesses: vi.fn(async () => []),
      },
    },
  ])("keeps close leases retryable when $evidence", async ({ processCleanup }) => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close-process-list ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-close-process-list", {
      leaseId: "lease-close-process-list",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:binding:test",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 777,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          ...processCleanup,
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

    expect(leaseStore.leases.get("lease-close-process-list")).toMatchObject({
      rootPid: 777,
      state: "open",
    });
    if ("platform" in processCleanup && processCleanup.platform === "win32") {
      expect(processCleanup.listProcesses).not.toHaveBeenCalled();
    }
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

  it("cleans up non-lease-aware wrapper commands through fallback close cleanup", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        pid: 920,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 920,
              ppid: 1,
              command: CODEX_ACP_WRAPPER_COMMAND,
            },
            { pid: 921, ppid: 920, command: "node child.js" },
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
      { pid: 921, signal: "SIGTERM" },
      { pid: 920, signal: "SIGTERM" },
    ]);
  });

  it("uses session lease metadata for fallback close cleanup identity checks", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        openclawGatewayInstanceId: "gateway-test",
        openclawLeaseId: "lease-record",
        pid: 920,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 920,
              ppid: 1,
              command: `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} other-lease ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`,
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
      probeAgent: "  OpenClaw  ",
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
