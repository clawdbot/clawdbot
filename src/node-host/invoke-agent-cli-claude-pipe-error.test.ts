import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import type { NodeHostClient } from "./client.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

function frame(params: unknown): NodeInvokeRequestPayload {
  return {
    id: "invoke-pipe-error",
    nodeId: "node-pipe-error",
    command: "agent.cli.claude.run.v1",
    paramsJSON: JSON.stringify(params),
  };
}

function client(): NodeHostClient {
  return {
    async request<T = Record<string, unknown>>() {
      return {} as T;
    },
  };
}

describe("Claude CLI node command pipe errors", () => {
  let realChild: import("node:child_process").ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    if (realChild && !realChild.killed) {
      realChild.kill("SIGKILL");
    }
    realChild = undefined;
    spawnMock.mockReset();
    vi.resetModules();
  });

  it("guards real child stdout/stderr pipe error events", async () => {
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    realChild = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnMock.mockReturnValueOnce(realChild as never);
    const { runClaudeCliNodeCommand } = await import("./invoke-agent-cli-claude.js");

    const request = { argv: ["-p"], idleTimeoutMs: 100, timeoutMs: 5_000 };

    const run = runClaudeCliNodeCommand({
      client: client(),
      frame: frame(request),
      request,
      argv: [process.execPath, ...request.argv],
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: request.timeoutMs,
    });

    expect(() => realChild?.stdout.emit("error", new Error("stdout pipe failure"))).not.toThrow();
    expect(() => realChild?.stderr.emit("error", new Error("stderr pipe failure"))).not.toThrow();
    realChild.kill("SIGKILL");

    await expect(run).resolves.toMatchObject({ success: false });
    expect(spawnMock).toHaveBeenCalledOnce();
  });
});
