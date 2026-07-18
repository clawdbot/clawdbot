// Qa Lab tests cover suite runtime agent process plugin behavior.
import { EventEmitter } from "node:events";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/node"));
const waitForGatewayHealthyMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitForTransportReadyMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("./node-exec.js", () => ({
  resolveQaNodeExecPath: resolveQaNodeExecPathMock,
}));

vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: waitForGatewayHealthyMock,
  waitForTransportReady: waitForTransportReadyMock,
}));

import { QA_CHILD_STDERR_TAIL_BYTES, QA_CHILD_STDOUT_MAX_BYTES } from "./child-output.js";
import {
  findManagedDreamingCronJob,
  listCronJobs,
  readDoctorMemoryStatus,
  runAgentPrompt,
  runQaCli,
  startAgentRun,
  waitForAgentRun,
  waitForAgentHistoryReply,
} from "./suite-runtime-agent-process.js";

type MockEmitter = {
  emit: (eventName: string | symbol, ...args: unknown[]) => boolean;
  on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MockEmitter;
  once: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MockEmitter;
};

type MockChildProcess = MockEmitter & {
  pid?: number;
  stdout: MockEmitter;
  stderr: MockEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockEmitter() {
  return new EventEmitter() as unknown as MockEmitter;
}

function createSpawnedProcess(params: { pid?: number } = {}) {
  const child = createMockEmitter() as MockChildProcess;
  child.pid = params.pid;
  child.stdout = createMockEmitter();
  child.stderr = createMockEmitter();
  child.kill = vi.fn();
  return child;
}

async function waitForSpawnCount(count: number) {
  await vi.waitFor(() => {
    expect(spawnMock).toHaveBeenCalledTimes(count);
  });
  await Promise.resolve();
}

function firstSpawnCall(): unknown[] | undefined {
  return spawnMock.mock.calls[0];
}

function firstGatewayCall(
  gatewayCall: ReturnType<typeof vi.fn>,
): [string, unknown, unknown] | undefined {
  return gatewayCall.mock.calls[0] as [string, unknown, unknown] | undefined;
}

describe("qa suite runtime agent process helpers", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    resolveQaNodeExecPathMock.mockClear();
    waitForGatewayHealthyMock.mockClear();
    waitForTransportReadyMock.mockClear();
  });

  it("runs the qa cli through the resolved node executable", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: { PATH: "/usr/bin" },
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["qa", "suite"],
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("close", 0);

    await expect(pending).resolves.toBe("ok");
    const spawnCall = firstSpawnCall();
    expect(spawnCall?.[0]).toBe("/usr/bin/node");
    expect(spawnCall?.[1]).toEqual([path.join("/repo", "dist", "index.js"), "qa", "suite"]);
    expect((spawnCall?.[2] as { cwd?: string; env?: unknown } | undefined)?.cwd).toBe(
      "/tmp/runtime",
    );
    expect((spawnCall?.[2] as { env?: unknown } | undefined)?.env).toEqual({ PATH: "/usr/bin" });
  });

  it("caps oversized qa cli timeout timers", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const child = createSpawnedProcess();
      spawnMock.mockReturnValue(child);

      const pending = runQaCli(
        {
          repoRoot: "/repo",
          gateway: {
            tempRoot: "/tmp/runtime",
            runtimeEnv: { PATH: "/usr/bin" },
          },
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "openai/gpt-5.6-luna-mini",
          providerMode: "mock-openai",
        } as never,
        ["qa", "suite"],
        { timeoutMs: Number.MAX_SAFE_INTEGER },
      );

      await waitForSpawnCount(1);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      child.stdout.emit("data", Buffer.from("ok\n"));
      child.emit("close", 0);
      await expect(pending).resolves.toBe("ok");
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")("kills timed-out qa cli process groups", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const child = createSpawnedProcess({ pid: 12345 });
      spawnMock.mockReturnValue(child);

      const pending = runQaCli(
        {
          repoRoot: "/repo",
          gateway: {
            tempRoot: "/tmp/runtime",
            runtimeEnv: { PATH: "/usr/bin" },
          },
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "openai/gpt-5.6-luna-mini",
          providerMode: "mock-openai",
        } as never,
        ["qa", "suite"],
        { timeoutMs: 1 },
      );
      const timeoutAssertion = expect(pending).rejects.toThrow(
        "qa cli timed out: openclaw qa suite",
      );

      await waitForSpawnCount(1);
      await timeoutAssertion;
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("force-kills timed-out Windows qa cli process trees with taskkill", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.SystemRoot = "C:\\Windows";
    delete process.env.WINDIR;
    try {
      const child = createSpawnedProcess({ pid: 12345 });
      spawnMock.mockReturnValue(child);
      spawnSyncMock.mockReturnValue({ status: 0 });

      const pending = runQaCli(
        {
          repoRoot: "/repo",
          gateway: {
            tempRoot: "/tmp/runtime",
            runtimeEnv: { PATH: "/usr/bin" },
          },
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "openai/gpt-5.6-luna-mini",
          providerMode: "mock-openai",
        } as never,
        ["qa", "suite"],
        { timeoutMs: 1 },
      );
      const timeoutAssertion = expect(pending).rejects.toThrow(
        "qa cli timed out: openclaw qa suite",
      );

      await waitForSpawnCount(1);
      await timeoutAssertion;
      expect(spawnSyncMock).toHaveBeenCalledWith(
        path.win32.join("C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", "12345", "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
          timeout: 5_000,
        },
      );
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      if (originalSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = originalSystemRoot;
      }
      if (originalWindir === undefined) {
        delete process.env.WINDIR;
      } else {
        process.env.WINDIR = originalWindir;
      }
    }
  });

  it("merges isolated env overrides into qa cli runs", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: { PATH: "/usr/bin", OPENCLAW_STATE_DIR: "/tmp/default-state" },
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["openclaw", "-m", "overview"],
      {
        env: {
          OPENCLAW_STATE_DIR: "/tmp/isolated-state",
          OPENCLAW_CONFIG_PATH: "/tmp/isolated-state/openclaw.json",
        },
      },
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("close", 0);

    await expect(pending).resolves.toBe("ok");
    const spawnCall = firstSpawnCall();
    expect(spawnCall?.[0]).toBe("/usr/bin/node");
    expect(spawnCall?.[1]).toEqual([
      path.join("/repo", "dist", "index.js"),
      "openclaw",
      "-m",
      "overview",
    ]);
    const spawnEnv = (spawnCall?.[2] as { env?: Record<string, string> } | undefined)?.env;
    expect(spawnEnv?.PATH).toBe("/usr/bin");
    expect(spawnEnv?.OPENCLAW_STATE_DIR).toBe("/tmp/isolated-state");
    expect(spawnEnv?.OPENCLAW_CONFIG_PATH).toBe("/tmp/isolated-state/openclaw.json");
  });

  it("parses json qa cli output when requested", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from('{"ok":true}\n'));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("parses json qa cli output after colored startup logs", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit(
      "data",
      Buffer.from(
        '\u001b[35m[plugins]\u001b[39m \u001b[36mcodex loaded plugin package metadata\u001b[39m\n{"results":[{"text":"ORBIT-10"}]}\n',
      ),
    );
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("parses pretty json qa cli output after startup logs", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit(
      "data",
      Buffer.from(
        '[plugins] memory-core loaded plugin package metadata\n{\n  "results": [\n    {\n      "text": "ORBIT-10"\n    }\n  ]\n}\n',
      ),
    );
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("waits for stdio close before parsing qa cli stdout", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.emit("exit", 0);
    child.stdout.emit("data", Buffer.from('{"results":[{"text":"LATE-STDOUT"}]}\n'));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "LATE-STDOUT" }] });
  });

  it("parses pretty json qa cli output before trailing stdout logs", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit(
      "data",
      Buffer.from(
        '[plugins] memory-core loaded plugin package metadata\n{\n  "results": [\n    {\n      "text": "ORBIT-10"\n    }\n  ]\n}\n[plugins] trailing diagnostic\n',
      ),
    );
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("ignores diagnostic json fragments before the qa cli payload", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit(
      "data",
      Buffer.from(
        '[plugins] diagnostic context {"ok":true}\n{"results":[{"text":"ORBIT-10"}]}\n[plugins] trailing diagnostic\n',
      ),
    );
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("ignores leading json diagnostic records before the qa cli payload", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"event":"startup-repair"}\n{"results":[{"text":"ORBIT-10"}]}\n[plugins] trailing diagnostic\n',
      ),
    );
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("ignores trailing json diagnostic records after the qa cli payload", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit(
      "data",
      Buffer.from(
        '[plugins] memory-core loaded plugin package metadata\n{\n  "results": [\n    {\n      "text": "ORBIT-10"\n    }\n  ]\n}\n{"event":"cleanup"}\n',
      ),
    );
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("rejects oversized qa cli stdout instead of parsing truncated output", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.alloc(QA_CHILD_STDOUT_MAX_BYTES + 1, "x"));
    child.emit("close", 0);

    await expect(pending).rejects.toThrow(
      `qa cli stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
    );
  });

  it("keeps only a bounded qa cli stderr tail for failure diagnostics", async () => {
    const child = createSpawnedProcess();
    spawnMock.mockReturnValue(child);

    const pending = runQaCli(
      {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: {},
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search", "--json"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stderr.emit(
      "data",
      Buffer.from(`head-marker\n${"x".repeat(QA_CHILD_STDERR_TAIL_BYTES)}\ntail-marker`),
    );
    child.emit("close", 1);

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("qa cli failed (1):");
    expect(message).toContain("qa cli stderr truncated to last");
    expect(message).toContain("tail-marker");
    expect(message).not.toContain("head-marker");
  });

  it("starts an agent run with transport-derived delivery metadata", async () => {
    const gatewayCall = vi.fn(async () => ({ runId: "run-1" }));
    const env = {
      gateway: { call: gatewayCall },
      transport: {
        buildAgentDelivery: vi.fn(() => ({
          channel: "qa-channel",
          to: "transport-target",
          replyChannel: "reply-channel",
          replyTo: "reply-target",
        })),
      },
    } as never;

    await expect(
      startAgentRun(env, {
        sessionKey: "session-1",
        message: "hello",
      }),
    ).resolves.toEqual({ runId: "run-1" });
    const gatewayArgs = firstGatewayCall(gatewayCall);
    expect(gatewayArgs?.[0]).toBe("agent");
    const agentPayload = gatewayArgs?.[1] as
      | {
          channel?: string;
          message?: string;
          replyChannel?: string;
          replyTo?: string;
          sessionKey?: string;
          to?: string;
        }
      | undefined;
    expect(agentPayload?.sessionKey).toBe("session-1");
    expect(agentPayload?.message).toBe("hello");
    expect(agentPayload?.channel).toBe("qa-channel");
    expect(agentPayload?.to).toBe("transport-target");
    expect(agentPayload?.replyChannel).toBe("reply-channel");
    expect(agentPayload?.replyTo).toBe("reply-target");
    expect(gatewayArgs?.[2]).toBeTypeOf("object");
  });

  it("starts an interactive run without CLI task tracking", async () => {
    const gatewayCall = vi.fn(async () => ({ runId: "run-chat", status: "started" }));
    const buildAgentDelivery = vi.fn(() => ({
      channel: "qa-channel",
      replyChannel: "qa-channel",
      replyTo: "dm:qa-operator",
    }));
    const env = {
      gateway: { call: gatewayCall },
      transport: {
        buildAgentDelivery,
      },
    } as never;

    await expect(
      startAgentRun(env, {
        sessionKey: "agent:qa:main",
        message: "hello",
        taskTracking: false,
      }),
    ).resolves.toEqual({ runId: "run-chat", status: "started" });
    expect(gatewayCall).toHaveBeenCalledWith(
      "chat.send",
      {
        idempotencyKey: expect.any(String),
        sessionKey: "agent:qa:main",
        message: "hello",
        deliver: true,
        originatingChannel: "qa-channel",
        originatingTo: "dm:qa-operator",
      },
      { timeoutMs: 30_000 },
    );
    expect(buildAgentDelivery).toHaveBeenCalledWith({ target: "dm:qa-operator" });
  });

  it("finds managed dreaming cron jobs across legacy and current payload contracts", () => {
    const legacy = {
      id: "legacy",
      name: "Memory Dreaming Promotion",
      payload: {
        kind: "systemEvent",
        text: "__openclaw_memory_core_short_term_promotion_dream__",
      },
    };
    const current = {
      id: "current",
      name: "Memory Dreaming Promotion",
      payload: {
        kind: "agentTurn",
        message: "__openclaw_memory_core_short_term_promotion_dream__",
        lightContext: true,
      },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
    };

    expect(findManagedDreamingCronJob([{ id: "other", name: "Other" }, legacy])).toBe(legacy);
    expect(findManagedDreamingCronJob([{ id: "other", name: "Other" }, current])).toBe(current);
  });

  it("waits for an agent run and fails when the run does not finish ok", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-2" })
      .mockResolvedValueOnce({ status: "error", error: "boom" });
    const env = {
      gateway: { call: gatewayCall },
      transport: {
        buildAgentDelivery: vi.fn(() => ({
          channel: "qa-channel",
          replyChannel: "reply-channel",
          replyTo: "reply-target",
        })),
      },
    } as never;

    await expect(
      runAgentPrompt(env, {
        sessionKey: "session-2",
        message: "hello",
      }),
    ).rejects.toThrow("agent.wait returned error: boom");
  });

  it("accepts completed agent wait status as a successful terminal run", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-completed" })
      .mockResolvedValueOnce({ status: "completed" });
    const env = {
      gateway: { call: gatewayCall },
      transport: {
        buildAgentDelivery: vi.fn(() => ({
          channel: "qa-channel",
          replyChannel: "reply-channel",
          replyTo: "reply-target",
        })),
      },
    } as never;

    await expect(
      runAgentPrompt(env, {
        sessionKey: "session-completed",
        message: "hello",
      }),
    ).resolves.toEqual({
      started: { runId: "run-completed" },
      waited: { status: "completed" },
    });
  });

  it("accepts malformed completed wait errors as successful terminal runs", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-error-completed" })
      .mockResolvedValueOnce({ status: "error", error: "completed" });
    const env = {
      gateway: { call: gatewayCall },
      transport: {
        buildAgentDelivery: vi.fn(() => ({
          channel: "qa-channel",
          replyChannel: "reply-channel",
          replyTo: "reply-target",
        })),
      },
    } as never;

    await expect(
      runAgentPrompt(env, {
        sessionKey: "session-error-completed",
        message: "hello",
      }),
    ).resolves.toEqual({
      started: { runId: "run-error-completed" },
      waited: { status: "error", error: "completed" },
    });
  });

  it("waits for the latest assistant history reply", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: "still working" }] })
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "HISTORY-REPLY-OK" }],
          },
        ],
      });

    await expect(
      waitForAgentHistoryReply(
        { gateway: { call: gatewayCall } } as never,
        "session-history",
        (text) => text === "HISTORY-REPLY-OK",
        1_000,
        1,
      ),
    ).resolves.toMatchObject({
      text: "HISTORY-REPLY-OK",
    });
    expect(gatewayCall).toHaveBeenLastCalledWith(
      "chat.history",
      { sessionKey: "session-history", limit: 12 },
      { timeoutMs: 10_000 },
    );
  });

  it("waits for a specific agent run id", async () => {
    const gatewayCall = vi.fn(async () => ({ status: "ok" }));

    await expect(
      waitForAgentRun({ gateway: { call: gatewayCall } } as never, "run-3"),
    ).resolves.toEqual({ status: "ok" });
    expect(gatewayCall).toHaveBeenCalledWith(
      "agent.wait",
      { runId: "run-3", timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
  });

  it.each(["restart", "aborted"])(
    "preserves the %s stop reason from agent.wait",
    async (stopReason) => {
      const result = { status: "error", stopReason };
      const gatewayCall = vi.fn(async () => result);

      await expect(
        waitForAgentRun({ gateway: { call: gatewayCall } } as never, "run-interrupted"),
      ).resolves.toEqual(result);
    },
  );

  it("caps the gateway client timeout when waiting for oversized agent runs", async () => {
    const gatewayCall = vi.fn(async () => ({ status: "ok" }));

    await expect(
      waitForAgentRun({ gateway: { call: gatewayCall } } as never, "run-oversized", 9e15),
    ).resolves.toEqual({ status: "ok" });

    expect(gatewayCall).toHaveBeenCalledWith(
      "agent.wait",
      { runId: "run-oversized", timeoutMs: MAX_TIMER_TIMEOUT_MS },
      { timeoutMs: MAX_TIMER_TIMEOUT_MS },
    );
  });

  it("lists cron jobs and doctor memory status through the gateway", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({
        jobs: [{ id: "job-1", name: "dreaming" }],
      })
      .mockResolvedValueOnce({
        dreaming: { enabled: true, shortTermCount: 3 },
      });
    const env = { gateway: { call: gatewayCall } } as never;

    await expect(listCronJobs(env)).resolves.toEqual([{ id: "job-1", name: "dreaming" }]);
    await expect(readDoctorMemoryStatus(env)).resolves.toEqual({
      dreaming: { enabled: true, shortTermCount: 3 },
    });
  });
});
