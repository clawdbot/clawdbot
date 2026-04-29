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

    expect(result).toEqual({ ok: true, pid: 4242 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("openclaw-launchd-restart-handoff");
    expect(args[6]).toBe("9876");
    expect(args[7]).toBe("ai.openclaw.gateway");
    expect(args[1]).toContain('while kill -0 "$wait_pid" >/dev/null 2>&1; do');
    expect(args[1]).toContain("exec >>'/Users/test/.openclaw/logs/gateway-restart.log' 2>&1");
    expect(args[1]).toContain("openclaw restart attempt source=launchd-handoff mode=kickstart");
    expect(args[1]).toContain('launchctl enable "$service_target"');
    expect(args[1]).toContain('if launchctl kickstart -k "$service_target"; then');
    expect(args[1]).not.toMatch(/launchctl[^\n]*\/dev\/null/);
    expect(args[1]).not.toContain("sleep 1");
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it("passes the plain label separately for start-after-exit mode", () => {
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    scheduleDetachedLaunchdRestartHandoff({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "default",
      },
      mode: "start-after-exit",
    });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[7]).toBe("ai.openclaw.gateway");
    expect(args[1]).toContain('if launchctl print "$service_target" >/dev/null 2>&1; then');
    expect(args[1]).toContain("reason=launchd-auto-reload");
    expect(args[1]).toContain("print_retry_count=$((print_retry_count - 1))");
    expect(args[1]).toContain("sleep 0.2");
    expect(args[1]).toContain('if launchctl bootstrap "$domain" "$plist_path"; then');
    expect(args[1]).toContain('if launchctl start "$label"; then');
    expect(args[1]).not.toContain('basename "$service_target"');
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

    const [, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string | undefined> },
    ];
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
