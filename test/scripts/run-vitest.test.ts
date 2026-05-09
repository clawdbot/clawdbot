import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  installVitestNoOutputWatchdog,
  resolveDirectNodeVitestArgs,
  resolveVitestNodeArgs,
  resolveVitestNoOutputTimeoutMs,
  resolveVitestSpawnParams,
  shouldSuppressVitestStderrLine,
} from "../../scripts/run-vitest.mjs";

describe("scripts/run-vitest", () => {
  it("adds --no-maglev to vitest child processes by default", () => {
    expect(resolveVitestNodeArgs({ PATH: "/usr/bin" })).toEqual(["--no-maglev"]);
  });

  it("detects pnpm exec node wrappers that can be spawned directly", () => {
    expect(
      resolveDirectNodeVitestArgs([
        "exec",
        "node",
        "--no-maglev",
        "node_modules/vitest/vitest.mjs",
      ]),
    ).toEqual(["--no-maglev", "node_modules/vitest/vitest.mjs"]);
    expect(resolveDirectNodeVitestArgs(["exec", "vitest", "run"])).toBeNull();
  });

  it("allows opting back into Maglev explicitly", () => {
    expect(
      resolveVitestNodeArgs({
        OPENCLAW_VITEST_ENABLE_MAGLEV: "1",
        PATH: "/usr/bin",
      }),
    ).toStrictEqual([]);
  });

  it("parses the optional no-output timeout env", () => {
    expect(resolveVitestNoOutputTimeoutMs({})).toBeNull();
    expect(resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "2500" })).toBe(
      2500,
    );
    expect(
      resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0" }),
    ).toBeNull();
  });

  it("spawns vitest in a detached process group on Unix hosts", () => {
    expect(resolveVitestSpawnParams({ PATH: "/usr/bin" }, "darwin")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    expect(resolveVitestSpawnParams({ PATH: "/usr/bin" }, "win32")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
  });

  it("reenables local check policy for local Vitest children", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: "/usr/bin",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
  });

  it("preserves explicit local-check disablement in CI", () => {
    expect(
      resolveVitestSpawnParams(
        {
          CI: "true",
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: "/usr/bin",
        },
        "linux",
      ).env,
    ).toEqual({
      CI: "true",
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it("caps native Rust worker pools for serial Vitest runs", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_TEST_PROJECTS_SERIAL: "1",
          PATH: "/usr/bin",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_TEST_PROJECTS_SERIAL: "1",
      PATH: "/usr/bin",
      RAYON_NUM_THREADS: "1",
      TOKIO_WORKER_THREADS: "1",
    });
  });

  it("keeps explicit native Rust worker pool settings", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_VITEST_MAX_WORKERS: "2",
          PATH: "/usr/bin",
          RAYON_NUM_THREADS: "8",
          TOKIO_WORKER_THREADS: "6",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_VITEST_MAX_WORKERS: "2",
      PATH: "/usr/bin",
      RAYON_NUM_THREADS: "8",
      TOKIO_WORKER_THREADS: "6",
    });
  });

  it("suppresses rolldown plugin timing noise while keeping other stderr intact", () => {
    expect(
      shouldSuppressVitestStderrLine(
        "\u001b[33m[PLUGIN_TIMINGS] Warning:\u001b[0m plugin `foo` was slow\n",
      ),
    ).toBe(true);
    expect(shouldSuppressVitestStderrLine("real failure output\n")).toBe(false);
  });

  it("kills silent vitest runs after the configured idle timeout", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const timeoutSpy = vi.fn();
      const forceKillSpy = vi.fn();
      const logSpy = vi.fn();

      const teardown = installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 5000,
        log: logSpy,
        onTimeout: timeoutSpy,
        onForceKill: forceKillSpy,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      vi.advanceTimersByTime(900);
      expect(timeoutSpy).not.toHaveBeenCalled();

      stdout.emit("data", "still alive");
      vi.advanceTimersByTime(900);
      expect(timeoutSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group.",
      );

      vi.advanceTimersByTime(5000);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] process group still alive after 5000ms; sending SIGKILL.",
      );

      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the runner label in watchdog logs when provided", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const logSpy = vi.fn();

      installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 0,
        label: "run --config test/vitest/vitest.secrets.config.ts",
        log: logSpy,
        onTimeout: () => {},
      });

      vi.advanceTimersByTime(1000);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group (run --config test/vitest/vitest.secrets.config.ts).",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
