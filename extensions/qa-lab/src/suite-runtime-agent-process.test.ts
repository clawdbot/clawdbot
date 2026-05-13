import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/node"));
const waitForGatewayHealthyMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitForTransportReadyMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./node-exec.js", () => ({
  resolveQaNodeExecPath: resolveQaNodeExecPathMock,
}));

vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: waitForGatewayHealthyMock,
  waitForTransportReady: waitForTransportReadyMock,
}));

import {
  findManagedDreamingCronJob,
  isManagedDreamingCronJob,
  listCronJobs,
  readDoctorMemoryStatus,
  runAgentPrompt,
  runQaCli,
  startAgentRun,
  waitForAgentRun,
  waitForMemorySearchMatch,
} from "./suite-runtime-agent-process.js";

type MockEmitter = {
  emit: (eventName: string | symbol, ...args: unknown[]) => boolean;
  on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MockEmitter;
  once: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MockEmitter;
};

type MockChildProcess = MockEmitter & {
  stdout: MockEmitter;
  stderr: MockEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockEmitter() {
  return new EventEmitter() as unknown as MockEmitter;
}

function createSpawnedProcess() {
  const child = createMockEmitter() as MockChildProcess;
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
        primaryModel: "openai/gpt-5.5",
        alternateModel: "openai/gpt-5.5-mini",
        providerMode: "mock-openai",
      } as never,
      ["qa", "suite"],
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("exit", 0);

    await expect(pending).resolves.toBe("ok");
    const spawnCall = firstSpawnCall();
    expect(spawnCall?.[0]).toBe("/usr/bin/node");
    expect(spawnCall?.[1]).toEqual([path.join("/repo", "dist", "index.js"), "qa", "suite"]);
    expect((spawnCall?.[2] as { cwd?: string; env?: unknown } | undefined)?.cwd).toBe(
      "/tmp/runtime",
    );
    expect((spawnCall?.[2] as { env?: unknown } | undefined)?.env).toEqual({ PATH: "/usr/bin" });
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
        primaryModel: "openai/gpt-5.5",
        alternateModel: "openai/gpt-5.5-mini",
        providerMode: "mock-openai",
      } as never,
      ["crestodian", "-m", "overview"],
      {
        env: {
          OPENCLAW_STATE_DIR: "/tmp/isolated-state",
          OPENCLAW_CONFIG_PATH: "/tmp/isolated-state/openclaw.json",
        },
      },
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("exit", 0);

    await expect(pending).resolves.toBe("ok");
    const spawnCall = firstSpawnCall();
    expect(spawnCall?.[0]).toBe("/usr/bin/node");
    expect(spawnCall?.[1]).toEqual([
      path.join("/repo", "dist", "index.js"),
      "crestodian",
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
        primaryModel: "openai/gpt-5.5",
        alternateModel: "openai/gpt-5.5-mini",
        providerMode: "mock-openai",
      } as never,
      ["memory", "search"],
      { json: true },
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from('{"ok":true}\n'));
    child.emit("exit", 0);

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
        primaryModel: "openai/gpt-5.5",
        alternateModel: "openai/gpt-5.5-mini",
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
    child.emit("exit", 0);

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
        primaryModel: "openai/gpt-5.5",
        alternateModel: "openai/gpt-5.5-mini",
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
    child.emit("exit", 0);

    await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
  });

  it("starts an agent run with transport-derived delivery metadata", async () => {
    const gatewayCall = vi.fn(async () => ({ runId: "run-1" }));
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
        }
      | undefined;
    expect(agentPayload?.sessionKey).toBe("session-1");
    expect(agentPayload?.message).toBe("hello");
    expect(agentPayload?.channel).toBe("qa-channel");
    expect(agentPayload?.replyChannel).toBe("reply-channel");
    expect(agentPayload?.replyTo).toBe("reply-target");
    expect(gatewayArgs?.[2]).toBeTypeOf("object");
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

    expect(isManagedDreamingCronJob(legacy)).toBe(true);
    expect(isManagedDreamingCronJob(current)).toBe(true);
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

  it("polls memory search results until the expected needle appears", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ path: "memory/2020-01-01.md", text: "ORBIT-9" }],
      })
      .mockResolvedValueOnce({
        results: [{ path: "memory/2020-01-01.md", text: "ORBIT-10" }],
      });

    await expect(
      waitForMemorySearchMatch({
        search,
        expectedNeedle: "ORBIT-10",
        timeoutMs: 2_000,
      }),
    ).resolves.toEqual({
      results: [{ path: "memory/2020-01-01.md", text: "ORBIT-10" }],
    });
    expect(search).toHaveBeenCalledTimes(2);
  });
});
