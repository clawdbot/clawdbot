import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildCliRespawnPlan,
  EXPERIMENTAL_WARNING_FLAG,
  OPENCLAW_NODE_EXTRA_CA_CERTS_READY,
  OPENCLAW_NODE_OPTIONS_READY,
  resolveCliRespawnCommand,
  runCliRespawnPlan,
} from "./entry.respawn.js";

type CliRespawnPlan = NonNullable<ReturnType<typeof buildCliRespawnPlan>>;

function expectCliRespawnPlan(plan: ReturnType<typeof buildCliRespawnPlan>): CliRespawnPlan {
  if (plan === null) {
    throw new Error("Expected CLI respawn plan");
  }
  return plan;
}

function requireFirstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("buildCliRespawnPlan", () => {
  it("returns null when respawn policy skips the argv", () => {
    expect(
      buildCliRespawnPlan({
        argv: ["node", "openclaw", "--help"],
        env: {},
        execArgv: [],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      }),
    ).toBeNull();
  });

  it("adds NODE_EXTRA_CA_CERTS and warning suppression in one respawn", () => {
    const plan = buildCliRespawnPlan({
      argv: ["node", "openclaw", "status"],
      env: {},
      execArgv: [],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.command).toBe(process.execPath);
    expect(respawnPlan.argv[0]).toBe(EXPERIMENTAL_WARNING_FLAG);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(respawnPlan.env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]).toBe("1");
    expect(respawnPlan.env[OPENCLAW_NODE_OPTIONS_READY]).toBe("1");
  });

  it.each(["tui", "terminal", "chat"] as const)(
    "preserves NODE_EXTRA_CA_CERTS respawn for interactive %s",
    (command) => {
      const plan = buildCliRespawnPlan({
        argv: ["node", "openclaw", command],
        env: {},
        execArgv: [],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      });

      const respawnPlan = expectCliRespawnPlan(plan);
      expect(respawnPlan.argv).toEqual(["openclaw", command]);
      expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
      expect(respawnPlan.env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]).toBe("1");
      expect(respawnPlan.env[OPENCLAW_NODE_OPTIONS_READY]).toBeUndefined();
    },
  );

  it("does not respawn interactive commands for warning suppression only", () => {
    expect(
      buildCliRespawnPlan({
        argv: ["node", "openclaw", "tui"],
        env: { [OPENCLAW_NODE_EXTRA_CA_CERTS_READY]: "1" },
        execArgv: [],
        autoNodeExtraCaCerts: undefined,
      }),
    ).toBeNull();
  });

  it("does not overwrite an existing NODE_EXTRA_CA_CERTS value", () => {
    const plan = buildCliRespawnPlan({
      argv: ["node", "openclaw", "status"],
      env: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" },
      execArgv: [],
      autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.env.NODE_EXTRA_CA_CERTS).toBe("/custom/ca.pem");
  });

  it("returns null when both respawn guards are already satisfied", () => {
    expect(
      buildCliRespawnPlan({
        argv: ["node", "openclaw", "status"],
        env: {
          [OPENCLAW_NODE_EXTRA_CA_CERTS_READY]: "1",
          [OPENCLAW_NODE_OPTIONS_READY]: "1",
        },
        execArgv: [EXPERIMENTAL_WARNING_FLAG],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      }),
    ).toBeNull();
  });

  it("does not respawn on Windows", () => {
    expect(
      buildCliRespawnPlan({
        argv: [
          "node",
          "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs",
          "onboard",
        ],
        env: {},
        execArgv: [],
        autoNodeExtraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
        platform: "win32",
      }),
    ).toBeNull();
  });

  it("respawns Volta shims through node so the shim is not called directly", () => {
    const plan = buildCliRespawnPlan({
      argv: ["/home/alice/.volta/bin/volta-shim", "/usr/local/bin/openclaw", "status"],
      env: { PATH: "/home/alice/.volta/bin:/usr/bin:/bin" },
      execArgv: [],
      execPath: "/home/alice/.volta/bin/volta-shim",
      autoNodeExtraCaCerts: undefined,
      platform: "linux",
    });

    const respawnPlan = expectCliRespawnPlan(plan);
    expect(respawnPlan.command).toBe("node");
    expect(respawnPlan.argv).toEqual([
      EXPERIMENTAL_WARNING_FLAG,
      "/usr/local/bin/openclaw",
      "status",
    ]);
  });
});

describe("resolveCliRespawnCommand", () => {
  it("keeps normal node paths absolute", () => {
    expect(resolveCliRespawnCommand({ execPath: "/usr/bin/node", platform: "linux" })).toBe(
      "/usr/bin/node",
    );
  });

  it("maps Volta's Unix shim target back to the named node shim", () => {
    expect(
      resolveCliRespawnCommand({
        execPath: "/home/alice/.volta/bin/volta-shim",
        platform: "linux",
      }),
    ).toBe("node");
  });
});

describe("runCliRespawnPlan", () => {
  it("spawns and bridges the respawn child", () => {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);
    const attachChildProcessBridge = vi.fn();
    const exit = vi.fn();
    const writeError = vi.fn();

    runCliRespawnPlan(
      {
        command: "/usr/bin/node",
        argv: ["/repo/openclaw/dist/entry.js", "status"],
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
      },
      {
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
        attachChildProcessBridge,
        exit: exit as unknown as (code?: number) => never,
        writeError,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/repo/openclaw/dist/entry.js", "status"],
      {
        stdio: "inherit",
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
      },
    );
    const [bridgeChild, bridgeOptions] = requireFirstMockCall(
      attachChildProcessBridge,
      "child process bridge attach",
    );
    expect(bridgeChild).toBe(child);
    expect(bridgeOptions).toEqual(expect.objectContaining({ onSignal: expect.any(Function) }));

    child.emit("exit", 0, null);

    expect(exit).toHaveBeenCalledWith(0);
    expect(writeError).not.toHaveBeenCalled();
  });

  it("force-kills a signaled respawn child that does not exit", () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    child.kill = kill as ChildProcess["kill"];
    const spawn = vi.fn(() => child);
    const exit = vi.fn();
    let onSignal: ((signal: NodeJS.Signals) => void) | undefined;

    try {
      runCliRespawnPlan(
        {
          command: "/usr/bin/node",
          argv: ["/repo/openclaw/dist/entry.js", "tui"],
          env: {},
        },
        {
          spawn: spawn as unknown as typeof import("node:child_process").spawn,
          attachChildProcessBridge: vi.fn((_child, options) => {
            onSignal = options?.onSignal;
            return { detach: vi.fn() };
          }),
          exit: exit as unknown as (code?: number) => never,
          writeError: vi.fn(),
        },
      );

      onSignal?.("SIGTERM");
      vi.advanceTimersByTime(1_000);

      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_000);

      expect(kill).toHaveBeenCalledWith(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
