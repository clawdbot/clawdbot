import { EventEmitter } from "node:events";
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
  listCronJobs,
  readDoctorMemoryStatus,
  runAgentPrompt,
  runQaCli,
  startAgentRun,
  waitForAgentRun,
  waitForMemorySearchMatch,
} from "./suite-runtime-agent-process.js";

function createSpawnedProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    once: (event: string, listener: (...args: unknown[]) => void) => unknown;
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

async function waitForSpawnCount(count: number) {
  while (spawnMock.mock.calls.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
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
        primaryModel: "openai/gpt-5.4",
        alternateModel: "openai/gpt-5.4-mini",
        providerMode: "mock-openai",
      } as never,
      ["qa", "suite"],
    );

    await waitForSpawnCount(1);
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("exit", 0);

    await expect(pending).resolves.toBe("ok");
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/repo/dist/index.js", "qa", "suite"],
      expect.objectContaining({
        cwd: "/tmp/runtime",
        env: { PATH: "/usr/bin" },
      }),
    );
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
        primaryModel: "openai/gpt-5.4",
        alternateModel: "openai/gpt-5.4-mini",
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
    expect(gatewayCall).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        sessionKey: "session-1",
        message: "hello",
        channel: "qa-channel",
        replyChannel: "reply-channel",
        replyTo: "reply-target",
      }),
      expect.any(Object),
    );
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
