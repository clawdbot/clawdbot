// Launchd restart handoff tests cover restart coordination on macOS.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const unrefMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import { scheduleDetachedLaunchdRestartHandoff } from "./launchd-restart-handoff.js";

type SpawnCall = [string, string[], { env: Record<string, string | undefined> }];

const execFileAsync = promisify(execFile);

function requireSpawnCall(callIndex = 0): SpawnCall {
  const call = spawnMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected spawn call ${callIndex}`);
  }
  const [command, args, options] = call;
  if (
    typeof command !== "string" ||
    !Array.isArray(args) ||
    !options ||
    typeof options !== "object"
  ) {
    throw new Error(`expected spawn call ${callIndex} with command, args, and options`);
  }
  return [command, args as string[], options as SpawnCall[2]];
}

async function executeReloadHandoff(launchctlStub: string): Promise<{
  calls: string[];
  exitCode: number;
  log: string;
}> {
  const noWaitPid = 0;
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-stub-"));
  try {
    const home = path.join(stubDir, "home");
    const callsPath = path.join(stubDir, "launchctl.calls");
    fs.mkdirSync(path.join(home, ".openclaw", "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(stubDir, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_CALLS_PATH"\n${launchctlStub}\n`,
    );
    fs.chmodSync(path.join(stubDir, "launchctl"), 0o755);
    fs.writeFileSync(path.join(stubDir, "sleep"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(stubDir, "sleep"), 0o755);

    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });
    scheduleDetachedLaunchdRestartHandoff({
      env: { HOME: home, OPENCLAW_PROFILE: "default" },
      mode: "reload",
      waitForPid: noWaitPid,
    });
    const [, args] = requireSpawnCall();
    const script = args[1];
    if (!script) {
      throw new Error("expected generated restart script");
    }

    let exitCode = 0;
    try {
      await execFileAsync(
        "/bin/sh",
        [
          "-c",
          script,
          "handoff-test",
          "gui/501/test.label",
          "gui/501",
          "/tmp/test.plist",
          String(noWaitPid),
        ],
        {
          env: {
            ...process.env,
            LAUNCHCTL_CALLS_PATH: callsPath,
            LAUNCHCTL_STUB_DIR: stubDir,
            PATH: `${stubDir}:${process.env.PATH}`,
          },
        },
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "number") {
        throw error;
      }
      exitCode = code;
    }

    const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n");
    const log = fs.readFileSync(
      path.join(home, ".openclaw", "logs", "gateway-restart.log"),
      "utf8",
    );
    return { calls, exitCode, log };
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  spawnMock.mockReset();
  unrefMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });
});

describe("scheduleDetachedLaunchdRestartHandoff", () => {
  it("waits for the caller pid before kickstarting launchd", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      waitForPid: 9876,
    });

    expect(result).toEqual({ ok: true, value: 4242 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = requireSpawnCall();
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("openclaw-launchd-restart-handoff");
    expect(args[6]).toBe("9876");
    expect(args[1]).toContain('while kill -0 "$wait_pid" >/dev/null 2>&1; do');
    expect(args[1]).toContain("exec >>'/Users/test/.openclaw/logs/gateway-restart.log' 2>&1");
    expect(args[1]).toContain("openclaw restart attempt source=handoff mode=kickstart");
    expect(args[1]).toContain("pid=%s interactive=0");
    expect(args[1]).toContain('launchctl enable "$service_target"');
    expect(args[1]).toContain('if launchctl kickstart -k "$service_target"; then');
    expect(args[1]).toContain(
      'if launchctl bootstrap "$domain" "$plist_path"; then\n    status=0\n  else\n    launchctl kickstart -k "$service_target"',
    );
    expect(args[1]).not.toMatch(/launchctl[^\n]*\/dev\/null/);
    expect(args[1]).not.toContain("sleep 1");
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it("uses the service target for start-after-exit mode", () => {
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    scheduleDetachedLaunchdRestartHandoff({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "default",
      },
      mode: "start-after-exit",
    });

    const [, args] = requireSpawnCall();
    expect(args[1]).toContain('if launchctl print "$service_target" >/dev/null 2>&1; then');
    expect(args[1]).toContain("reason=launchd-auto-reload");
    expect(args[1]).toContain("print_retry_count=$((print_retry_count - 1))");
    expect(args[1]).toContain("sleep 0.2");
    expect(args[1]).toContain('if launchctl bootstrap "$domain" "$plist_path"; then');
    expect(args[1]).not.toContain('if launchctl start "$label"; then');
    expect(args[1]).not.toContain('basename "$service_target"');
  });

  it("outwaits launchd's stop window after bootout and retries bootstrap for reload mode", () => {
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    scheduleDetachedLaunchdRestartHandoff({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "default",
      },
      mode: "reload",
      waitForPid: 9876,
    });

    const [, args] = requireSpawnCall();
    expect(args[1]).toContain("openclaw restart attempt source=handoff mode=reload");
    expect(args[1]).toContain('launchctl enable "$service_target"');
    expect(args[1]).toContain('launchctl bootout "$service_target"');
    // The unload poll must outlast launchd's ExitTimeOut SIGKILL ceiling plus
    // margin (#110137): 35 × 1s vs the old 15 × 0.2s stop window.
    expect(args[1]).toContain('bootout_wait_count="35"');
    expect(args[1]).toContain('if ! launchctl print "$service_target" >/dev/null 2>&1; then');
    expect(args[1]).toContain("sleep 1");
    // Bootstrap failures retry; kickstart -k only fires while the label is
    // registered, because it cannot succeed on a booted-out label.
    expect(args[1]).toContain('bootstrap_retry_count="15"');
    expect(args[1]).toContain('if launchctl bootstrap "$domain" "$plist_path"; then');
    expect(args[1]).toContain(
      'if launchctl print "$service_target" >/dev/null 2>&1; then\n    if launchctl kickstart -k "$service_target"; then',
    );
    expect(args[1]).toContain("bootstrap_retry_count=$((bootstrap_retry_count - 1))");
  });

  it("executes the generated reload handoff through a delayed launchd stop", async () => {
    const result = await executeReloadHandoff(`
case "$1" in
  print)
    count_file="$LAUNCHCTL_STUB_DIR/print-count"
    count=0
    [ -f "$count_file" ] && count=$(sed -n '1p' "$count_file")
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    [ "$count" -le 20 ] && exit 0
    exit 113
    ;;
  bootstrap) exit 0 ;;
  *) exit 0 ;;
esac`);

    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("print "))).toHaveLength(21);
    expect(result.calls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(1);
    expect(result.log).toContain("restart done");
    expect(result.log).not.toContain("restart failed");
  });

  it("retries bootstrap when the label disappears between print and kickstart", async () => {
    const result = await executeReloadHandoff(`
case "$1" in
  print)
    count_file="$LAUNCHCTL_STUB_DIR/print-count"
    count=0
    [ -f "$count_file" ] && count=$(sed -n '1p' "$count_file")
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    [ "$count" -eq 2 ] && exit 0
    exit 113
    ;;
  bootstrap)
    count_file="$LAUNCHCTL_STUB_DIR/bootstrap-count"
    count=0
    [ -f "$count_file" ] && count=$(sed -n '1p' "$count_file")
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    [ "$count" -eq 1 ] && exit 5
    exit 0
    ;;
  kickstart) exit 113 ;;
  *) exit 0 ;;
esac`);

    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(2);
    expect(result.calls.filter((call) => call.startsWith("kickstart "))).toHaveLength(1);
    expect(result.log).toContain("restart done");
    expect(result.log).not.toContain("restart failed");
  });

  it("reload retry exhaustion exits nonzero instead of reporting a successful restart", async () => {
    // A completed if with a false condition leaves $? at 0. Keep this
    // execution-level check so exhausted retries cannot report success while
    // the LaunchAgent remains deregistered.
    const result = await executeReloadHandoff(
      'case "$1" in bootstrap) exit 5 ;; print) exit 113 ;; *) exit 0 ;; esac',
    );

    expect(result.exitCode).toBe(5);
    expect(result.calls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(15);
    const { log } = result;
    expect(log).toContain("restart failed");
    expect(log).not.toContain("restart done");
  });

  it("sanitizes restart helper environment overrides before spawning", () => {
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    scheduleDetachedLaunchdRestartHandoff({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "default",
        PATH: "/tmp/evil-bin",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        NPM_CONFIG_GLOBALCONFIG: "/tmp/evil-npmrc",
      },
      mode: "kickstart",
    });

    const [, args, options] = requireSpawnCall();
    expect(args[1]).toContain("exec >>'/Users/test/.openclaw/logs/gateway-restart.log' 2>&1");
    expect(args[1]).not.toContain("/tmp/evil-bin");
    expect(args[1]).not.toContain("/tmp/evil.dylib");
    expect(args[1]).not.toContain("/tmp/evil-npmrc");
    expect(options.env.OPENCLAW_PROFILE).toBe("default");
    expect(options.env.PATH).not.toBe("/tmp/evil-bin");
    expect(options.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(options.env.NPM_CONFIG_GLOBALCONFIG).toBeUndefined();
  });

  it("rejects invalid launchd labels before spawning the helper", () => {
    expect(() => {
      scheduleDetachedLaunchdRestartHandoff({
        env: {
          HOME: "/Users/test",
          OPENCLAW_LAUNCHD_LABEL: "../evil/\n\u001b[31mlabel\u001b[0m",
        },
        mode: "kickstart",
      });
    }).toThrow("Invalid launchd label: ../evil/label");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
