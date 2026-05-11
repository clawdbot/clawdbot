import { describe, expect, it, vi } from "vitest";
import {
  buildGatewayWatchTmuxCommand,
  resolveGatewayWatchTmuxSessionName,
  runGatewayWatchTmuxMain,
} from "../../scripts/gateway-watch-tmux.mjs";

const createOutput = () => {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write: (message: string) => {
        chunks.push(message);
      },
    },
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function spawnCall(mock: unknown, callIndex: number) {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(callIndex);
  expect(call, `spawn call ${callIndex + 1}`).toBeDefined();
  return call as Array<unknown>;
}

function expectSpawn(mock: unknown, callIndex: number, command: string, args: Array<unknown>) {
  const call = spawnCall(mock, callIndex);
  expect(call[0]).toBe(command);
  expect(call[1]).toEqual(args);
  return requireRecord(call[2], "spawn options");
}

describe("gateway-watch tmux wrapper", () => {
  it("derives stable session names from profile and port", () => {
    expect(resolveGatewayWatchTmuxSessionName({ args: ["gateway", "--force"], env: {} })).toBe(
      "openclaw-gateway-watch-main",
    );
    expect(
      resolveGatewayWatchTmuxSessionName({
        args: ["gateway", "--force", "--port", "19001"],
        env: { OPENCLAW_PROFILE: "Dev Profile" },
      }),
    ).toBe("openclaw-gateway-watch-dev-profile-19001");
    expect(
      resolveGatewayWatchTmuxSessionName({
        args: ["--dev", "gateway", "--port=18789"],
        env: {},
      }),
    ).toBe("openclaw-gateway-watch-dev");
  });

  it("builds a login-shell command that runs the raw watcher in the repo", () => {
    const command = buildGatewayWatchTmuxCommand({
      args: ["gateway", "--force", "--raw-stream-path", "a b.jsonl"],
      cwd: "/repo with spaces/openclaw",
      env: {
        OPENCLAW_GATEWAY_PORT: "19001",
        OPENCLAW_PROFILE: "Dev Profile",
        OPENCLAW_TRACE_SYNC_IO: "0",
        SHELL: "/bin/zsh",
      },
      nodePath: "/opt/node",
      sessionName: "openclaw-gateway-watch-main",
    });

    expect(command).toContain("exec '/bin/zsh' -lc");
    expect(command).toContain("/repo with spaces/openclaw");
    expect(command).toContain("'OPENCLAW_GATEWAY_WATCH_TMUX_CHILD=1'");
    expect(command).toContain("'OPENCLAW_GATEWAY_WATCH_SESSION=openclaw-gateway-watch-main'");
    expect(command).toContain("'\\''-u'\\'' '\\''NO_COLOR'\\''");
    expect(command).toContain("'FORCE_COLOR=1'");
    expect(command).toContain("'OPENCLAW_GATEWAY_PORT=19001'");
    expect(command).toContain("'OPENCLAW_PROFILE=Dev Profile'");
    expect(command).toContain("'OPENCLAW_TRACE_SYNC_IO=0'");
    expect(command).toContain("/opt/node");
    expect(command).toContain("scripts/watch-node.mjs");
    expect(command).toContain("gateway");
    expect(command).toContain("--force");
    expect(command).toContain("'a b.jsonl'");
  });

  it("consumes benchmark flags and passes the CPU profile dir to the watched child", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force", "--benchmark"],
      cwd: "/repo",
      env: { SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdout: stdout.stream,
    });

    expect(code).toBe(0);
    const command = spawnSync.mock.calls[1]?.[1]?.[6] as string;
    expect(command).toContain("'OPENCLAW_RUN_NODE_CPU_PROF_DIR=.artifacts/gateway-watch-profiles'");
    expect(command).toContain("'OPENCLAW_TRACE_SYNC_IO=0'");
    expect(command).not.toContain("--benchmark");
    expect(command).toContain("'gateway'");
    expect(command).toContain("'--force'");
    expect(stderr.chunks.join("")).toContain(
      "gateway:watch benchmark CPU profiles: .artifacts/gateway-watch-profiles",
    );
  });

  it("preserves explicit sync I/O tracing in benchmark mode", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force", "--benchmark"],
      cwd: "/repo",
      env: { OPENCLAW_TRACE_SYNC_IO: "1", SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdout: stdout.stream,
    });

    expect(code).toBe(0);
    const command = spawnSync.mock.calls[1]?.[1]?.[6] as string;
    expect(command).toContain("'OPENCLAW_TRACE_SYNC_IO=1'");
    expect(command).toContain(
      "'OPENCLAW_RUN_NODE_OUTPUT_LOG=.artifacts/gateway-watch-profiles/gateway-watch-output.log'",
    );
    expect(command).toContain("'OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR=1'");
    expect(stderr.chunks.join("")).toContain(
      "gateway:watch benchmark trace output: .artifacts/gateway-watch-profiles/gateway-watch-output.log",
    );
  });

  it("can remove --force from benchmarked watch runs", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force", "--benchmark-no-force"],
      cwd: "/repo",
      env: { SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdout: stdout.stream,
    });

    expect(code).toBe(0);
    const command = spawnSync.mock.calls[1]?.[1]?.[6] as string;
    expect(command).toContain("'OPENCLAW_RUN_NODE_CPU_PROF_DIR=.artifacts/gateway-watch-profiles'");
    expect(command).not.toContain("--benchmark-no-force");
    expect(command).toContain("'gateway'");
    expect(command).not.toContain("'--force'");
    expect(stderr.chunks.join("")).toContain("gateway:watch benchmark running without --force");
  });

  it("preserves an explicit color override for the tmux child", () => {
    const command = buildGatewayWatchTmuxCommand({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: {
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        SHELL: "/bin/zsh",
      },
      nodePath: "/opt/node",
      sessionName: "openclaw-gateway-watch-main",
    });

    expect(command).toContain("'FORCE_COLOR=0'");
    expect(command).not.toContain("'\\''-u'\\'' '\\''NO_COLOR'\\''");
    expect(command).not.toContain("'FORCE_COLOR=1'");
  });

  it("creates a detached tmux session when none exists", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: { SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdout: stdout.stream,
    });

    expect(code).toBe(0);
    expect(
      expectSpawn(spawnSync, 0, "tmux", ["has-session", "-t", "openclaw-gateway-watch-main"])
        .encoding,
    ).toBe("utf8");
    const newSessionCall = spawnCall(spawnSync, 1);
    expect(newSessionCall[0]).toBe("tmux");
    const newSessionArgs = newSessionCall[1] as Array<unknown>;
    expect(newSessionArgs.slice(0, 6)).toEqual([
      "new-session",
      "-d",
      "-s",
      "openclaw-gateway-watch-main",
      "-c",
      "/repo",
    ]);
    expect(String(newSessionArgs[6])).toContain("scripts/watch-node.mjs");
    expect(requireRecord(newSessionCall[2], "spawn options").encoding).toBe("utf8");
    expect(
      expectSpawn(spawnSync, 2, "tmux", [
        "set-option",
        "-q",
        "-t",
        "openclaw-gateway-watch-main",
        "@openclaw.gateway_watch.cwd",
        "/repo",
      ]).encoding,
    ).toBe("utf8");
    expect(
      expectSpawn(spawnSync, 3, "tmux", [
        "set-environment",
        "-t",
        "openclaw-gateway-watch-main",
        "OPENCLAW_GATEWAY_WATCH_CWD",
        "/repo",
      ]).encoding,
    ).toBe("utf8");
    expect(stderr.chunks.join("")).toContain(
      "gateway:watch started in tmux session openclaw-gateway-watch-main",
    );
    expect(stdout.chunks.join("")).toContain("tmux attach -t openclaw-gateway-watch-main");
    expect(stdout.chunks.join("")).toContain(
      "tmux show-options -v -t openclaw-gateway-watch-main @openclaw.gateway_watch.cwd",
    );
  });

  it("auto-attaches in an interactive terminal after creating a session", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: { SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdinIsTTY: true,
      stdout: stdout.stream,
      stdoutIsTTY: true,
    });

    expect(code).toBe(0);
    expect(
      expectSpawn(spawnSync, 4, "tmux", ["attach-session", "-t", "openclaw-gateway-watch-main"])
        .stdio,
    ).toBe("inherit");
    expect(stdout.chunks.join("")).not.toContain("tmux attach -t");
  });

  it("switches tmux clients instead of nesting attach when already inside tmux", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: { SHELL: "/bin/zsh", TMUX: "/tmp/tmux-501/default,1,0" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdinIsTTY: true,
      stdout: stdout.stream,
      stdoutIsTTY: true,
    });

    expect(code).toBe(0);
    expect(
      expectSpawn(spawnSync, 4, "tmux", ["switch-client", "-t", "openclaw-gateway-watch-main"])
        .stdio,
    ).toBe("inherit");
  });

  it("keeps detached output in CI unless attach is forced", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: { CI: "1", SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdinIsTTY: true,
      stdout: stdout.stream,
      stdoutIsTTY: true,
    });

    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(4);
    expect(stdout.chunks.join("")).toContain("tmux attach -t openclaw-gateway-watch-main");
  });

  it("respawns the existing tmux pane on repeated runs", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force", "--port=19001"],
      cwd: "/repo",
      env: { OPENCLAW_PROFILE: "dev", SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdout: stdout.stream,
    });

    expect(code).toBe(0);
    const respawnCall = spawnCall(spawnSync, 1);
    expect(respawnCall[0]).toBe("tmux");
    const respawnArgs = respawnCall[1] as Array<unknown>;
    expect(respawnArgs.slice(0, 6)).toEqual([
      "respawn-pane",
      "-k",
      "-t",
      "openclaw-gateway-watch-dev-19001",
      "-c",
      "/repo",
    ]);
    expect(String(respawnArgs[6])).toContain("scripts/watch-node.mjs");
    expect(requireRecord(respawnCall[2], "spawn options").encoding).toBe("utf8");
    expect(stderr.chunks.join("")).toContain(
      "gateway:watch restarted in tmux session openclaw-gateway-watch-dev-19001",
    );
  });

  it("recreates a stale session when its active pane target is missing", () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "can't find window: 0" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: { CI: "1", SHELL: "/bin/zsh" },
      nodePath: "/node",
      spawnSync,
      stderr: stderr.stream,
      stdout: stdout.stream,
    });

    expect(code).toBe(0);
    const staleRespawnCall = spawnCall(spawnSync, 1);
    expect(staleRespawnCall[0]).toBe("tmux");
    const staleRespawnArgs = staleRespawnCall[1] as Array<unknown>;
    expect(staleRespawnArgs.slice(0, 6)).toEqual([
      "respawn-pane",
      "-k",
      "-t",
      "openclaw-gateway-watch-main",
      "-c",
      "/repo",
    ]);
    expect(String(staleRespawnArgs[6])).toContain("scripts/watch-node.mjs");
    expect(requireRecord(staleRespawnCall[2], "spawn options").encoding).toBe("utf8");
    expect(
      expectSpawn(spawnSync, 2, "tmux", ["kill-session", "-t", "openclaw-gateway-watch-main"])
        .encoding,
    ).toBe("utf8");
    const recreatedCall = spawnCall(spawnSync, 3);
    expect(recreatedCall[0]).toBe("tmux");
    const recreatedArgs = recreatedCall[1] as Array<unknown>;
    expect(recreatedArgs.slice(0, 6)).toEqual([
      "new-session",
      "-d",
      "-s",
      "openclaw-gateway-watch-main",
      "-c",
      "/repo",
    ]);
    expect(String(recreatedArgs[6])).toContain("scripts/watch-node.mjs");
    expect(requireRecord(recreatedCall[2], "spawn options").encoding).toBe("utf8");
  });

  it("runs the raw foreground watcher when tmux mode is disabled", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: { OPENCLAW_GATEWAY_WATCH_TMUX: "0" },
      nodePath: "/node",
      spawnSync,
    });

    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "/node",
      ["scripts/watch-node.mjs", "gateway", "--force"],
      {
        cwd: "/repo",
        env: { OPENCLAW_GATEWAY_WATCH_TMUX: "0" },
        stdio: "inherit",
      },
    );
  });

  it("prints a raw-mode hint when tmux is unavailable", () => {
    const stderr = createOutput();
    const spawnSync = vi.fn().mockReturnValue({
      error: Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }),
    });

    const code = runGatewayWatchTmuxMain({
      args: ["gateway", "--force"],
      cwd: "/repo",
      env: {},
      spawnSync,
      stderr: stderr.stream,
    });

    expect(code).toBe(1);
    expect(stderr.chunks.join("")).toContain("tmux is not installed or not on PATH");
  });
});
