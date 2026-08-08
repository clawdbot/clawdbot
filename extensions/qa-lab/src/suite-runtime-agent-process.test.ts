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
const readSessionTranscriptSummaryMock = vi.hoisted(() => vi.fn());

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

vi.mock("./suite-runtime-agent-session.js", () => ({
  readSessionTranscriptSummary: readSessionTranscriptSummaryMock,
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

const QA_CLI_ENV = {
  repoRoot: "/repo",
  gateway: {
    tempRoot: "/tmp/runtime",
    runtimeEnv: { PATH: "/usr/bin" },
  },
  primaryModel: "openai/gpt-5.6-luna",
  alternateModel: "openai/gpt-5.6-luna-mini",
  providerMode: "mock-openai",
} as unknown as Parameters<typeof runQaCli>[0];

const QA_CLI_JSON_ENV = {
  ...QA_CLI_ENV,
  gateway: { tempRoot: "/tmp/runtime", runtimeEnv: {} },
} as unknown as Parameters<typeof runQaCli>[0];

function startMockQaCli(params: {
  args: string[];
  child?: MockChildProcess;
  env?: Parameters<typeof runQaCli>[0];
  options?: Parameters<typeof runQaCli>[2];
}) {
  const child = params.child ?? createSpawnedProcess();
  spawnMock.mockReturnValue(child);
  return {
    child,
    pending: runQaCli(params.env ?? QA_CLI_ENV, params.args, params.options),
  };
}

function createAgentPromptEnv(gatewayCall: ReturnType<typeof vi.fn>) {
  return {
    gateway: { call: gatewayCall },
    transport: {
      buildAgentDelivery: vi.fn(() => ({
        channel: "qa-channel",
        replyChannel: "reply-channel",
        replyTo: "reply-target",
      })),
    },
  } as never;
}

describe("qa suite runtime agent process helpers", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    resolveQaNodeExecPathMock.mockClear();
    waitForGatewayHealthyMock.mockClear();
    waitForTransportReadyMock.mockClear();
    readSessionTranscriptSummaryMock.mockReset();
  });

  it("runs the qa cli through the resolved node executable", async () => {
    const { child, pending } = startMockQaCli({ args: ["qa", "suite"] });

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
      const { child, pending } = startMockQaCli({
        args: ["qa", "suite"],
        options: { timeoutMs: Number.MAX_SAFE_INTEGER },
      });

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
    vi.useFakeTimers();
    try {
      const child = createSpawnedProcess({ pid: 12345 });
      const { pending } = startMockQaCli({
        args: ["qa", "suite"],
        child,
        options: { timeoutMs: 1 },
      });
      const errorPromise = pending.catch((value: unknown) => value);
      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      child.stdout.emit(
        "data",
        Buffer.from(
          `stdout-head-marker\n${"x".repeat(QA_CHILD_STDOUT_MAX_BYTES)}\nstdout-tail-marker`,
        ),
      );
      child.stderr.emit(
        "data",
        Buffer.from(
          `stderr-head-marker\n${"x".repeat(QA_CHILD_STDERR_TAIL_BYTES)}\nstderr-tail-marker`,
        ),
      );
      await vi.advanceTimersByTimeAsync(1);

      const error = await errorPromise;
      expect(error).toMatchObject({ code: "qa_cli_timeout" });
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("qa cli timed out: openclaw qa suite");
      expect(message).toContain("stdout:\n[qa cli stdout truncated to last");
      expect(message).toContain("stdout-tail-marker");
      expect(message).not.toContain("stdout-head-marker");
      expect(message).toContain("stderr:\n[qa cli stderr truncated to last");
      expect(message).toContain("stderr-tail-marker");
      expect(message).not.toContain("stderr-head-marker");
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
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
      spawnSyncMock.mockReturnValue({ status: 0 });
      const { pending } = startMockQaCli({
        args: ["qa", "suite"],
        child,
        options: { timeoutMs: 1 },
      });
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
    const { child, pending } = startMockQaCli({
      env: {
        repoRoot: "/repo",
        gateway: {
          tempRoot: "/tmp/runtime",
          runtimeEnv: { PATH: "/usr/bin", OPENCLAW_STATE_DIR: "/tmp/default-state" },
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna-mini",
        providerMode: "mock-openai",
      } as never,
      args: ["openclaw", "-m", "overview"],
      options: {
        env: {
          OPENCLAW_STATE_DIR: "/tmp/isolated-state",
          OPENCLAW_CONFIG_PATH: "/tmp/isolated-state/openclaw.json",
        },
      },
    });

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
    const { child, pending } = startMockQaCli({
      env: QA_CLI_JSON_ENV,
      args: ["memory", "search"],
      options: { json: true },
    });

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from('{"ok":true}\n'));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it.each([
    {
      title: "parses json qa cli output after colored startup logs",
      stdout:
        '\u001b[35m[plugins]\u001b[39m \u001b[36mcodex loaded plugin package metadata\u001b[39m\n{"results":[{"text":"ORBIT-10"}]}\n',
    },
    {
      title: "parses pretty json qa cli output after startup logs",
      stdout:
        '[plugins] memory-core loaded plugin package metadata\n{\n  "results": [\n    {\n      "text": "ORBIT-10"\n    }\n  ]\n}\n',
    },
    {
      title: "parses pretty json qa cli output before trailing stdout logs",
      stdout:
        '[plugins] memory-core loaded plugin package metadata\n{\n  "results": [\n    {\n      "text": "ORBIT-10"\n    }\n  ]\n}\n[plugins] trailing diagnostic\n',
    },
    {
      title: "ignores diagnostic json fragments before the qa cli payload",
      stdout:
        '[plugins] diagnostic context {"ok":true}\n{"results":[{"text":"ORBIT-10"}]}\n[plugins] trailing diagnostic\n',
    },
    {
      title: "ignores leading json diagnostic records before the qa cli payload",
      stdout:
        '{"event":"startup-repair"}\n{"results":[{"text":"ORBIT-10"}]}\n[plugins] trailing diagnostic\n',
    },
    {
      title: "ignores trailing json diagnostic records after the qa cli payload",
      stdout:
        '[plugins] memory-core loaded plugin package metadata\n{\n  "results": [\n    {\n      "text": "ORBIT-10"\n    }\n  ]\n}\n{"event":"cleanup"}\n',
    },
  ])("$title", async ({ stdout }) => {
    const { child, pending } = startMockQaCli({
      env: QA_CLI_JSON_ENV,
      args: ["memory", "search", "--json"],
      options: { json: true },
    });

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("waits for stdio close before parsing qa cli stdout", async () => {
    const { child, pending } = startMockQaCli({
      env: QA_CLI_JSON_ENV,
      args: ["memory", "search", "--json"],
      options: { json: true },
    });

    await waitForSpawnCount(1);
    child.emit("exit", 0);
    child.stdout.emit("data", Buffer.from('{"results":[{"text":"LATE-STDOUT"}]}\n'));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "LATE-STDOUT" }] });
  });

  it("rejects oversized qa cli stdout instead of parsing truncated output", async () => {
    const { child, pending } = startMockQaCli({
      env: QA_CLI_JSON_ENV,
      args: ["memory", "search", "--json"],
      options: { json: true },
    });

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.alloc(QA_CHILD_STDOUT_MAX_BYTES + 1, "x"));
    child.emit("close", 0);

    await expect(pending).rejects.toThrow(
      `qa cli stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
    );
  });

  it("keeps only a bounded qa cli stderr tail for failure diagnostics", async () => {
    const { child, pending } = startMockQaCli({
      env: QA_CLI_JSON_ENV,
      args: ["memory", "search", "--json"],
      options: { json: true },
    });

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
    const env = createAgentPromptEnv(gatewayCall);

    await expect(
      runAgentPrompt(env, {
        sessionKey: "session-2",
        message: "hello",
      }),
    ).rejects.toThrow("agent.wait returned error: boom");
  });

  it("accepts completed agent wait status as a successful terminal run", async () => {
    const terminalReply = { disposition: "visible" as const, text: "completed reply" };
    const terminalDelivery = { status: "sent" as const, resultCount: 1 };
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-completed" })
      .mockResolvedValueOnce({ status: "completed", terminalDelivery, terminalReply });
    const env = createAgentPromptEnv(gatewayCall);

    await expect(
      runAgentPrompt(env, {
        sessionKey: "session-completed",
        message: "hello",
      }),
    ).resolves.toEqual({
      started: { runId: "run-completed" },
      waited: { status: "completed", terminalDelivery, terminalReply },
    });
  });

  it("accepts malformed completed wait errors as successful terminal runs", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-error-completed" })
      .mockResolvedValueOnce({ status: "error", error: "completed" });
    const env = createAgentPromptEnv(gatewayCall);

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

  it("waits for persisted transcript tool evidence after agent completion", async () => {
    vi.useFakeTimers();
    try {
      const gatewayCall = vi
        .fn()
        .mockResolvedValueOnce({ runId: "run-transcript-evidence" })
        .mockResolvedValueOnce({ status: "completed" });
      readSessionTranscriptSummaryMock
        .mockResolvedValueOnce({
          assistantToolCallCounts: {},
          completedToolCallCounts: {},
          successfulToolCallCounts: {},
          finalText: "",
        })
        .mockResolvedValueOnce({
          assistantToolCallCounts: { web_fetch: 1 },
          completedToolCallCounts: { web_fetch: 1 },
          successfulToolCallCounts: { web_fetch: 1 },
          finalText: "",
        });
      const env = createAgentPromptEnv(gatewayCall);

      const pending = runAgentPrompt(env, {
        sessionKey: "session-transcript-evidence",
        message: "call web_fetch",
        transcriptToolName: "web_fetch",
        requireSuccessfulTranscriptToolResult: true,
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({
        started: { runId: "run-transcript-evidence" },
        waited: { status: "completed" },
      });
      expect(readSessionTranscriptSummaryMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a persisted failed tool result after the call is visible", async () => {
    vi.useFakeTimers();
    try {
      const gatewayCall = vi
        .fn()
        .mockResolvedValueOnce({ runId: "run-failed-tool-evidence" })
        .mockResolvedValueOnce({ status: "completed" });
      readSessionTranscriptSummaryMock
        .mockResolvedValueOnce({
          assistantToolCallCounts: { session_status: 1 },
          completedToolCallCounts: {},
          successfulToolCallCounts: {},
          finalText: "",
        })
        .mockResolvedValueOnce({
          assistantToolCallCounts: { session_status: 1 },
          completedToolCallCounts: { session_status: 1 },
          successfulToolCallCounts: {},
          finalText: "",
        });
      const env = createAgentPromptEnv(gatewayCall);

      const pending = runAgentPrompt(env, {
        sessionKey: "session-failed-tool-evidence",
        message: "call session_status with invalid input",
        transcriptToolName: "session_status",
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({
        started: { runId: "run-failed-tool-evidence" },
        waited: { status: "completed" },
      });
      expect(readSessionTranscriptSummaryMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("retries structured transient history failures through gateway log wrappers", async () => {
    vi.useFakeTimers();
    try {
      const gatewayError = Object.assign(new Error("session history is rebuilding"), {
        gatewayCode: "UNAVAILABLE",
        retryable: true,
        retryAfterMs: 250,
        details: { method: "chat.history" },
      });
      const wrappedError = new Error("gateway call failed", {
        cause: new Error("gateway rpc failed", { cause: gatewayError }),
      });
      const gatewayCall = vi
        .fn()
        .mockRejectedValueOnce(wrappedError)
        .mockResolvedValueOnce({
          messages: [{ role: "assistant", content: "HISTORY-RETRY-OK" }],
        });

      const pending = waitForAgentHistoryReply(
        { gateway: { call: gatewayCall } } as never,
        "session-history-retry",
        (text) => text === "HISTORY-RETRY-OK",
        1_000,
        1,
      );
      await vi.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toEqual({ text: "HISTORY-RETRY-OK" });
      expect(gatewayCall).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the final retryable history failure when the poll deadline expires", async () => {
    const gatewayError = Object.assign(new Error("session history is rebuilding"), {
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 1,
      details: { method: "chat.history" },
    });
    const wrappedError = new Error("gateway call failed", { cause: gatewayError });
    const gatewayCall = vi.fn().mockRejectedValue(wrappedError);

    await expect(
      waitForAgentHistoryReply(
        { gateway: { call: gatewayCall } } as never,
        "session-history-retry-timeout",
        () => false,
        220,
        50,
      ),
    ).rejects.toMatchObject({
      message: "timed out after 220ms",
      cause: wrappedError,
    });
    expect(gatewayCall.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not attach a recovered history failure to a later predicate timeout", async () => {
    const gatewayError = Object.assign(new Error("session history is rebuilding"), {
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 1,
      details: { method: "chat.history" },
    });
    const gatewayCall = vi
      .fn()
      .mockRejectedValueOnce(gatewayError)
      .mockResolvedValue({ messages: [{ role: "assistant", content: "still working" }] });

    const timeoutError = await waitForAgentHistoryReply(
      { gateway: { call: gatewayCall } } as never,
      "session-history-recovered-timeout",
      () => false,
      220,
      50,
    ).catch((error: unknown) => error);

    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError).not.toHaveProperty("cause");
    expect(gatewayCall.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not retry transient gateway errors for a different method", async () => {
    const gatewayError = Object.assign(new Error("gateway method is rebuilding"), {
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 250,
      details: { method: "chat.startup" },
    });
    const gatewayCall = vi.fn().mockRejectedValueOnce(gatewayError);

    await expect(
      waitForAgentHistoryReply(
        { gateway: { call: gatewayCall } } as never,
        "session-history-wrong-method",
        () => false,
        1_000,
        1,
      ),
    ).rejects.toBe(gatewayError);
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("does not retry unavailable gateway errors without the retryable contract", async () => {
    const gatewayError = Object.assign(new Error("history unavailable"), {
      gatewayCode: "UNAVAILABLE",
      retryable: false,
      retryAfterMs: 250,
      details: { method: "chat.history" },
    });
    const gatewayCall = vi.fn().mockRejectedValueOnce(gatewayError);

    await expect(
      waitForAgentHistoryReply(
        { gateway: { call: gatewayCall } } as never,
        "session-history-not-retryable",
        () => false,
        1_000,
        1,
      ),
    ).rejects.toBe(gatewayError);
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("does not retry retry-shaped predicate failures", async () => {
    const predicateError = Object.assign(new Error("predicate unavailable"), {
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 250,
      details: { method: "chat.history" },
    });
    const gatewayCall = vi.fn().mockResolvedValueOnce({
      messages: [{ role: "assistant", content: "candidate reply" }],
    });

    await expect(
      waitForAgentHistoryReply(
        { gateway: { call: gatewayCall } } as never,
        "session-history-predicate-error",
        async () => {
          throw predicateError;
        },
        1_000,
        1,
      ),
    ).rejects.toBe(predicateError);
    expect(gatewayCall).toHaveBeenCalledOnce();
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
