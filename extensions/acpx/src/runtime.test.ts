// ACPX tests cover runtime plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestedModelUnsupportedError } from "acpx/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeEvent,
  type AcpRuntimeTurn,
} from "../runtime-api.js";
import { OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import { AcpxRuntime, testing, type AcpSessionStore } from "./runtime.js";

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

const DOCUMENTED_OPENCLAW_BRIDGE_COMMAND =
  "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main";
const CODEX_ACP_COMMAND = "npx @agentclientprotocol/codex-acp@1.1.2";
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

  it("exposes assertSupportedRuntimeSessionMode as a typed guard", () => {
    expect(testing.assertSupportedRuntimeSessionMode("persistent")).toBeUndefined();
    expect(testing.assertSupportedRuntimeSessionMode("oneshot")).toBeUndefined();
    expect(() => testing.assertSupportedRuntimeSessionMode("run" as never)).toThrow(
      AcpRuntimeError,
    );
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

  it("strips the OpenClaw Anthropic provider prefix for Claude ACP startup", async () => {
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
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:claude:acp:test",
      agent: "claude",
      mode: "persistent",
      model: "claude-sonnet-4-6",
      sessionOptions: { model: "claude-sonnet-4-6" },
    });
  });

  it("keeps Claude ACP model ids intact after stripping the OpenClaw provider prefix", () => {
    expect(testing.normalizeClaudeAcpModelOverride("anthropic/claude-sonnet-4-6")).toBe(
      "claude-sonnet-4-6",
    );
    expect(testing.normalizeClaudeAcpModelOverride("anthropic/claude-opus-4-8")).toBe(
      "claude-opus-4-8",
    );
    expect(testing.normalizeClaudeAcpModelOverride("anthropic/claude-haiku-4-5")).toBe(
      "claude-haiku-4-5",
    );
    expect(testing.normalizeClaudeAcpModelOverride("anthropic/claude-sonnet-4-6-1m")).toBe(
      "claude-sonnet-4-6-1m",
    );
    expect(testing.normalizeClaudeAcpModelOverride("custom-model")).toBe("custom-model");
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
    vi.spyOn(delegate, "startTurn").mockImplementation(
      (input): AcpRuntimeTurn => ({
        requestId: input.requestId,
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
      requestId: "turn-1",
    });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }

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
    const startTurn = vi.spyOn(delegate, "startTurn").mockImplementation(
      (input): AcpRuntimeTurn => ({
        requestId: input.requestId,
        events: (async function* () {
          yield { type: "done" as const, stopReason: "end_turn" };
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }),
    );

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
      `npx @agentclientprotocol/codex-acp@1.1.2 ${OPENCLAW_CODEX_CONFIG_ARG} '{"model":"gpt-5.4","model_reasoning_effort":"medium"}'`,
    );
    expect(testing.isCodexAcpCommand("openclaw acp")).toBe(false);
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

  it.each<{ model: string | undefined; thinking?: string; override: Record<string, string> }>([
    { model: "openai/gpt-5.4", override: { model: "gpt-5.4" } },
    {
      model: "openai/gpt-5.4",
      thinking: "high",
      override: { model: "gpt-5.4", reasoningEffort: "high" },
    },
    { model: "gpt-5.4/high", override: { model: "gpt-5.4", reasoningEffort: "high" } },
    { model: "gpt-5.4", override: { model: "gpt-5.4" } },
    { model: undefined, thinking: "low", override: { reasoningEffort: "low" } },
    { model: "", override: {} },
  ])(
    "classifies supported Codex ACP model request ($model, $thinking) as an override",
    ({ model, thinking, override }) => {
      expect(testing.classifyCodexAcpModelRequest(model, thinking)).toEqual({
        kind: "override",
        override,
      });
    },
  );

  it.each<{ model: string; thinking?: string; expected: Record<string, unknown> }>([
    { model: "google/gemini-3.1-flash-lite", expected: { kind: "unsupported" } },
    {
      model: "google/gemini-3.1-flash-lite",
      thinking: "low",
      expected: { kind: "unsupported", thinkingOverride: { reasoningEffort: "low" } },
    },
    { model: "gpt-5.4/ultra", expected: { kind: "unsupported" } },
    { model: "/high", expected: { kind: "unsupported" } },
  ])(
    "classifies unsupported Codex ACP model request ($model, $thinking) without thinking-slot routing",
    ({ model, thinking, expected }) => {
      expect(testing.classifyCodexAcpModelRequest(model, thinking)).toEqual(expected);
    },
  );

  it.each(["openai/foo/bar", "openai/", "openai//high"])(
    "fails closed on malformed openai-qualified Codex ACP model request %s",
    (model) => {
      expect(() => testing.classifyCodexAcpModelRequest(model)).toThrow(AcpRuntimeError);
    },
  );

  it("fails closed on an unsupported Codex ACP thinking value", () => {
    expect(() => testing.classifyCodexAcpModelRequest(undefined, "superhigh")).toThrow(
      AcpRuntimeError,
    );
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
      value: "openai/gpt-5.4",
    });

    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "gpt-5.4",
    });
    expect(setConfigOption).toHaveBeenCalledOnce();
  });

  it.each(["google/gemini-3.1-flash-lite", "gpt-5.4/ultra", "openai/foo/bar"])(
    "fails closed on Codex ACP model config control %s without re-injecting it",
    async (value) => {
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
    },
  );

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
    { key: "thinking", value: "minimal", expected: "low" },
    { key: "reasoning_effort", value: "x-high", expected: "xhigh" },
  ])("normalizes Codex ACP $key=$value to reasoning effort", async ({ key, value, expected }) => {
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
      key,
      value,
    });

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

    expect(setConfigOption).toHaveBeenCalledOnce();
    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "model",
      value: "claude-sonnet-4-6",
    });
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
