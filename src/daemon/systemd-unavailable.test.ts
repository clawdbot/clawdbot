// Systemd unavailable tests cover fallback behavior when systemd is not present.
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { execFileUtf8 } from "./exec-file.js";
import { isLaunchctlNotLoaded } from "./launchd-exec.js";
import {
  assertSystemdAvailable,
  isSystemctlAvailable,
  isSystemdUserServiceAvailable,
} from "./systemd-exec.js";
import {
  uninstallLegacySystemdUnits,
  uninstallUserSystemdGatewayUnit,
} from "./systemd-lifecycle.js";
import {
  classifySystemdUnavailableDetail,
  isSystemctlMissingDetail,
  isSystemdUserBusUnavailableDetail,
} from "./systemd-unavailable.js";

describe("classifySystemdUnavailableDetail", () => {
  it("classifies missing systemctl details", () => {
    expect(isSystemctlMissingDetail("spawn systemctl ENOENT")).toBe(true);
    expect(classifySystemdUnavailableDetail("systemctl not available")).toBe("missing_systemctl");
  });

  it("classifies user bus/session failures", () => {
    expect(
      isSystemdUserBusUnavailableDetail(
        "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
      ),
    ).toBe(true);
    expect(
      classifySystemdUnavailableDetail(
        "systemctl --user unavailable: Failed to connect to bus: No medium found",
      ),
    ).toBe("user_bus_unavailable");
    expect(
      classifySystemdUnavailableDetail(
        "systemctl --user unavailable: Failed to connect to bus: Permission denied",
      ),
    ).toBe("user_bus_unavailable");
  });

  it("classifies generic systemd-unavailable details", () => {
    expect(
      classifySystemdUnavailableDetail("System has not been booted with systemd as init system"),
    ).toBe("generic_unavailable");
    expect(classifySystemdUnavailableDetail("not supported on this host")).toBe(
      "generic_unavailable",
    );
  });

  it("returns null for unrelated details", () => {
    expect(classifySystemdUnavailableDetail("permission denied")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("systemd process availability", () => {
  function systemctlEnv(dir: string) {
    return {
      HOME: dir,
      PATH: dir,
      XDG_RUNTIME_DIR: dir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(dir, "bus")}`,
    };
  }

  it.each(["ENOENT", "EACCES"])("rejects unavailable systemctl with %s", async (errorCode) => {
    await withTempDir("openclaw-systemctl-", async (dir) => {
      if (errorCode === "EACCES") {
        await fs.writeFile(path.join(dir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      }
      const env = systemctlEnv(dir);
      await expect(isSystemctlAvailable(env)).resolves.toBe(false);
      await expect(isSystemdUserServiceAvailable(env)).resolves.toBe(false);
      await expect(assertSystemdAvailable(env)).rejects.toThrow("systemctl not available");

      const result = await execFileUtf8("systemctl", ["private-argument"], { env });
      expect(result).toMatchObject({ stdout: "", code: 1, errorCode });
      expect(result.stderr).not.toContain("private-argument");
      expect(isLaunchctlNotLoaded(result)).toBe(false);
    });
  });

  it.each([
    { output: "running", code: 0, available: true },
    { output: "degraded", code: 1, available: true },
    { output: "Failed to connect to bus: No medium found", code: 1, available: false },
  ])("preserves manager status $output", async ({ output, code, available }) => {
    await withTempDir("openclaw-systemctl-", async (dir) => {
      await fs.writeFile(
        path.join(dir, "systemctl"),
        `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`,
        { mode: 0o700 },
      );
      const env = systemctlEnv(dir);
      await expect(execFileUtf8("systemctl", ["--user", "status"], { env })).resolves.toEqual({
        stdout: `${output}\n`,
        stderr: "",
        code,
        termination: "exit",
      });
      await expect(isSystemctlAvailable(env)).resolves.toBe(true);
      await expect(isSystemdUserServiceAvailable(env)).resolves.toBe(available);
      if (available) {
        await expect(assertSystemdAvailable(env)).resolves.toBeUndefined();
      } else {
        await expect(assertSystemdAvailable(env)).rejects.toThrow("systemctl --user unavailable");
      }
    });
  });

  it.each(["timeout", "signal"])("rejects partial status after %s", async (termination) => {
    await withTempDir("openclaw-systemctl-", async (dir) => {
      await fs.writeFile(
        path.join(dir, "systemctl"),
        `#!/bin/sh\nprintf 'Could not find service\\n'\n${termination === "timeout" ? "exec /bin/sleep 10" : "kill -TERM $$"}\n`,
        { mode: 0o700 },
      );
      const env = systemctlEnv(dir);
      const timeout = termination === "timeout" ? 500 : undefined;
      const runAfterOutput = async <T>(run: () => Promise<T>): Promise<T> => {
        if (termination !== "timeout") {
          return await run();
        }
        const ready = createDeferredCore();
        const runCommand = processExec.runCommandWithTimeout;
        const commandSpy = vi
          .spyOn(processExec, "runCommandWithTimeout")
          .mockImplementation((argv, options) =>
            runCommand(argv, {
              ...(typeof options === "number" ? { timeoutMs: options } : options),
              onOutputChunk: (_chunk, stream) => {
                if (stream === "stdout") {
                  ready.resolve();
                }
              },
            }),
          );
        // Timeout normalization must follow observed child output, not race
        // a cold shell startup on a loaded test worker.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const result = run();
        try {
          await ready.promise;
          await vi.advanceTimersByTimeAsync(500);
          return await result;
        } finally {
          await vi.runOnlyPendingTimersAsync();
          vi.useRealTimers();
          commandSpy.mockRestore();
          await result.catch(() => undefined);
        }
      };
      await runAfterOutput(async () => {
        await expect(assertSystemdAvailable(env, timeout)).rejects.toThrow(
          "systemctl --user unavailable",
        );
      });
      const result = await runAfterOutput(() =>
        execFileUtf8("systemctl", ["--user", "status"], {
          env,
          timeout,
          killSignal: "SIGKILL",
        }),
      );
      expect(result).toMatchObject({ stdout: "Could not find service\n", termination });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        termination === "timeout" ? "Command timed out" : "Command was terminated by SIGTERM",
      );
      expect(isLaunchctlNotLoaded(result)).toBe(false);
      if (termination === "signal") {
        await expect(isSystemctlAvailable(env)).resolves.toBe(true);
        await expect(isSystemdUserServiceAvailable(env)).resolves.toBe(false);
      }
    });
  });

  describe.each([
    { unitName: "clawdbot-gateway.service", uninstall: uninstallLegacySystemdUnits },
    { unitName: "openclaw-gateway.service", uninstall: uninstallUserSystemdGatewayUnit },
  ])("$unitName cleanup", ({ unitName, uninstall }) => {
    it.each([
      { availability: "signal", disableFails: true },
      { availability: "signal", disableFails: false },
      { availability: "missing", disableFails: false },
    ])(
      "handles $availability status with disable failure $disableFails",
      async ({ availability, disableFails }) => {
        await withTempDir("openclaw-systemctl-cleanup-", async (dir) => {
          const env = systemctlEnv(dir);
          const unitPath = path.join(dir, ".config/systemd/user", unitName);
          const definition = "[Unit]\nDescription=Gateway cleanup fixture\n";
          await fs.mkdir(path.dirname(unitPath), { recursive: true });
          await fs.writeFile(unitPath, definition);
          if (availability !== "missing") {
            await fs.writeFile(
              path.join(dir, "systemctl"),
              [
                "#!/bin/sh",
                'printf "%s\\n" "$*" >> "$HOME/systemctl.calls"',
                'case " $* " in',
                '*" status "*) kill -TERM $$ ;;',
                '*" is-enabled "*) printf "enabled\\n" ;;',
                '*" disable "*)',
                `  test -f "$HOME/.config/systemd/user/${unitName}" || exit 98`,
                disableFails ? "  kill -TERM $$ ;;" : "  exit 0 ;;",
                "esac",
              ].join("\n"),
              { mode: 0o700 },
            );
          }
          let output = "";
          const stdout = new Writable({
            write(chunk, _encoding, callback) {
              output += chunk.toString();
              callback();
            },
          });
          if (disableFails) {
            await expect(uninstall({ env, stdout })).rejects.toThrow("systemctl disable failed:");
            await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(definition);
            expect(output).not.toContain("Removed");
          } else {
            await uninstall({ env, stdout });
            await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
            expect(output).toContain("Removed");
          }
          if (availability === "missing") {
            await expect(fs.access(path.join(dir, "systemctl.calls"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            expect(output).toContain("systemctl unavailable");
          } else {
            const calls = (await fs.readFile(path.join(dir, "systemctl.calls"), "utf8"))
              .trim()
              .split("\n");
            expect(calls).toContain(`--user disable --now ${unitName}`);
            expect(calls.includes("--user daemon-reload")).toBe(!disableFails);
            expect(output).not.toContain("systemctl unavailable");
          }
        });
      },
    );
  });
});
