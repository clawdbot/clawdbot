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

import {
  scheduleDetachedLaunchdMaintenancePark,
  scheduleDetachedLaunchdRestartHandoff,
} from "./launchd-restart-handoff.js";

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

async function executeHandoff(
  mode: "park" | "reload" | "start-after-exit",
  launchctlStub: string,
  systemOwnership: "absent" | "loaded" = "absent",
): Promise<{
  calls: string[];
  exitCode: number;
  log: string;
}> {
  const noWaitPid = 0;
  const stubDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launchd-stub-")));
  try {
    const home = path.join(stubDir, "home");
    const stateDir = path.join(home, ".openclaw");
    const systemDaemonsDir = path.join(stubDir, "LaunchDaemons");
    const handoffEnv = {
      HOME: home,
      OPENCLAW_PROFILE: "default",
      OPENCLAW_STATE_DIR: stateDir,
      BOUNDARY_SERVICE: "synthetic-service",
    };
    vi.stubGlobal("process", {
      ...process,
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        TMPDIR: stubDir,
        BOUNDARY_PARENT: "synthetic-parent",
      },
    });
    const callsPath = path.join(stubDir, "launchctl.calls");
    fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
    fs.mkdirSync(systemDaemonsDir);
    fs.writeFileSync(
      path.join(stubDir, "launchctl"),
      `#!/bin/sh
LAUNCHCTL_CALLS_PATH="$TMPDIR/launchctl.calls"
LAUNCHCTL_STUB_DIR="$TMPDIR"
printf '%s\\n' "$*" >> "$LAUNCHCTL_CALLS_PATH"
printf '%s:%s:%s\\n' "\${BOUNDARY_PARENT+present}" "\${BOUNDARY_SERVICE+present}" "\${OPENCLAW_PROFILE+present}" >> "$TMPDIR/environment.calls"
if [ "$1" = "print" ] && [ "$2" = "system/ai.openclaw.gateway" ]; then
  ${systemOwnership === "loaded" ? "exit 0" : "printf 'Could not find service\\n' >&2; exit 113"}
fi
${launchctlStub}
`,
    );
    fs.chmodSync(path.join(stubDir, "launchctl"), 0o755);
    fs.writeFileSync(path.join(stubDir, "sleep"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(stubDir, "sleep"), 0o755);

    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock, once: vi.fn() });
    if (mode === "park") {
      scheduleDetachedLaunchdMaintenancePark({
        env: handoffEnv,
        waitForPid: noWaitPid,
      });
    } else {
      scheduleDetachedLaunchdRestartHandoff({
        env: handoffEnv,
        mode,
        waitForPid: noWaitPid,
      });
    }
    const [, args, options] = requireSpawnCall();
    const script = args[1]?.replaceAll(
      "/Library/LaunchDaemons",
      `'${systemDaemonsDir.replaceAll("'", "'\\''")}'`,
    );
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
          path.join(stubDir, "test.plist"),
          String(noWaitPid),
        ],
        {
          env: options.env,
        },
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "number") {
        throw error;
      }
      exitCode = code;
    }

    const envCalls = fs
      .readFileSync(path.join(stubDir, "environment.calls"), "utf8")
      .trim()
      .split("\n");
    expect(envCalls.length).toBeGreaterThan(0);
    expect(envCalls.every((call) => call === "::")).toBe(true);
    const calls = fs
      .readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter((call) => call !== "print system/ai.openclaw.gateway");
    const log = fs.readFileSync(path.join(stateDir, "logs", "gateway-restart.log"), "utf8");
    return { calls, exitCode, log };
  } finally {
    vi.unstubAllGlobals();
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  spawnMock.mockReset();
  unrefMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock, once: vi.fn() });
});

describe("scheduleDetachedLaunchdRestartHandoff", () => {
  it("waits for the caller pid before kickstarting launchd", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
    };
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock, once: vi.fn() });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      waitForPid: 9876,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.any(Promise),
    });
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
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock, once: vi.fn() });

    scheduleDetachedLaunchdRestartHandoff({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "default",
      },
      mode: "start-after-exit",
    });

    const [, args] = requireSpawnCall();
    expect(args[1]).toContain('if launchctl kickstart "$service_target"; then');
    expect(args[1]).toContain('if launchctl bootstrap "$domain" "$plist_path"; then');
    expect(args[1]).not.toContain('kickstart -k "$service_target"');
    expect(args[1]).not.toContain('if launchctl start "$label"; then');
    expect(args[1]).not.toContain('basename "$service_target"');
  });

  it("kickstarts after exit without replacing a running KeepAlive process", async () => {
    const result = await executeHandoff(
      "start-after-exit",
      'case "$1" in enable|kickstart) exit 0 ;; *) exit 1 ;; esac',
    );

    expect(result.exitCode).toBe(0);
    expect(result.calls).toContain("enable gui/501/test.label");
    expect(result.calls).toContain("kickstart gui/501/test.label");
    expect(result.calls.some((call) => call.includes("kickstart -k"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("bootstrap "))).toBe(false);
    expect(result.log).toContain("restart done");
  });

  it("refuses detached activation when the system domain owns the label", async () => {
    const result = await executeHandoff(
      "start-after-exit",
      'case "$1" in enable|kickstart) exit 0 ;; *) exit 1 ;; esac',
      "loaded",
    );

    expect(result.exitCode).toBe(78);
    expect(result.calls).toEqual([]);
    expect(result.log).toContain("restart blocked");
    expect(result.log).toContain("loaded system LaunchDaemon system/ai.openclaw.gateway");
  });

  it("parks the service with bootout after the caller exits", async () => {
    const result = await executeHandoff(
      "park",
      'case "$1" in bootout) exit 0 ;; *) exit 1 ;; esac',
    );

    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual(["bootout gui/501/test.label"]);
    expect(result.log).toContain("service park done");
  });

  it("outwaits launchd's stop window after bootout and retries bootstrap for reload mode", () => {
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock, once: vi.fn() });

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
    const result = await executeHandoff(
      "reload",
      `
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
esac`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("print "))).toHaveLength(21);
    expect(result.calls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(1);
    expect(result.log).toContain("restart done");
    expect(result.log).not.toContain("restart failed");
  });

  it("retries bootstrap when the label disappears between print and kickstart", async () => {
    const result = await executeHandoff(
      "reload",
      `
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
esac`,
    );

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
    const result = await executeHandoff(
      "reload",
      'case "$1" in bootstrap) exit 5 ;; print) exit 113 ;; *) exit 0 ;; esac',
    );

    expect(result.exitCode).toBe(5);
    expect(result.calls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(15);
    const { log } = result;
    expect(log).toContain("restart failed");
    expect(log).not.toContain("restart done");
  });

  it("sanitizes restart helper environment overrides before spawning", () => {
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock, once: vi.fn() });

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
    expect(options.env.OPENCLAW_PROFILE).toBeUndefined();
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

  it("reports an asynchronous helper spawn failure", async () => {
    const listeners = new Map<string, () => void>();
    spawnMock.mockReturnValue({
      pid: undefined,
      unref: unrefMock,
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
    });

    const result = scheduleDetachedLaunchdRestartHandoff({ mode: "start-after-exit" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    listeners.get("error")?.();
    await expect(result.value).resolves.toBe(false);
  });

  it("reports a successfully spawned helper", async () => {
    const listeners = new Map<string, () => void>();
    spawnMock.mockReturnValue({
      pid: 4242,
      unref: unrefMock,
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
    });

    const result = scheduleDetachedLaunchdRestartHandoff({ mode: "start-after-exit" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    listeners.get("spawn")?.();
    await expect(result.value).resolves.toBe(true);
  });
});
