import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { readWindowsProcessStartTimeSync } from "../infra/windows-process-start.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveServiceManagerEnv", () => {
  it("keeps native context without accepting arbitrary names or prefixes", () => {
    const native = {
      PATH: "/native/bin",
      HOME: "/home/native",
      USER: "native",
      LOGNAME: "native",
      TMPDIR: "/tmp/native",
      TMP: "/tmp",
      TEMP: "/tmp",
      LANG: "C",
      LANGUAGE: "en",
      LC_ALL: "C",
      LC_CTYPE: "C",
      LC_MESSAGES: "C",
      LC_COLLATE: "C",
      LC_NUMERIC: "C",
      LC_MONETARY: "C",
      LC_TIME: "C",
      TZ: "UTC",
      TERM: "dumb",
      COLORTERM: "",
      NO_COLOR: "",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus",
      DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/system",
      XDG_RUNTIME_DIR: "/run/native",
      XDG_CONFIG_HOME: "/config",
      XDG_CONFIG_DIRS: "/configs",
      XDG_DATA_HOME: "/data",
      XDG_DATA_DIRS: "/shared",
      SYSTEMD_UNIT_PATH: "/units",
      SUDO_USER: "caller",
      SUDO_UID: "1000",
      SUDO_GID: "1000",
      SYSTEMD_OFFLINE: "0",
      SYSTEMD_IN_CHROOT: "0",
      SYSTEMD_BUS_TIMEOUT: "3s",
    };
    const source = {
      ...native,
      BOUNDARY_PARENT_ONLY: "synthetic",
      OPENCLAW_PROFILE: "private",
      SYSTEMD_APPLICATION: "synthetic",
      DBUS_APPLICATION: "synthetic",
      XDG_APPLICATION: "synthetic",
      LC_APPLICATION: "synthetic",
      " PATH": "invalid",
      "PATH ": "invalid",
      NODE_OPTIONS: "--inspect",
      SHELL: "/bin/sh",
      LD_PRELOAD: "synthetic",
      DYLD_INSERT_LIBRARIES: "synthetic",
      HTTPS_PROXY: "synthetic",
      SSH_AUTH_SOCK: "synthetic",
      SYSTEMD_PAGER: "synthetic",
      EDITOR: "synthetic",
      SUDO_COMMAND: "synthetic",
      SUDO_ASKPASS: "synthetic",
    };
    expect(resolveServiceManagerEnv(source)).toEqual(native);
    expect(source.BOUNDARY_PARENT_ONLY).toBe("synthetic");
  });

  it("defaults only an omitted source and preserves explicit empty and undefined values", () => {
    vi.stubEnv("HOME", "/parent/home");
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    expect(resolveServiceManagerEnv().HOME).toBe("/parent/home");
    expect(resolveServiceManagerEnv(undefined).HOME).toBe("/parent/home");
    expect(resolveServiceManagerEnv().BOUNDARY_PARENT_ONLY).toBeUndefined();
    expect(resolveServiceManagerEnv({})).toEqual({});
    expect(resolveServiceManagerEnv({ HOME: undefined, PATH: "", NO_COLOR: "" })).toEqual({
      PATH: "",
      NO_COLOR: "",
    });
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "preserves %s casing and first-key undefined semantics",
    (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const source = {
        Path: "later",
        PATH: undefined,
        hOmE: "/mixed",
        HOME: "/first",
        path: "last",
      };
      expect(resolveServiceManagerEnv(source)).toEqual(
        platform === "win32" ? { HOME: "/first" } : { Path: "later", HOME: "/first" },
      );
      expect(source.Path).toBe("later");
      expect(
        resolveServiceManagerEnv({ Path: "mixed", path: "last", SystemRoot: "C:\\Windows" }),
      ).toEqual(
        platform === "win32" ? { Path: "mixed", SystemRoot: "C:\\Windows" } : { Path: "mixed" },
      );
    },
  );

  it("retains Windows executable, profile and account context", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const native = {
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemDrive: "C:",
      UserProfile: "C:\\Users\\native",
      HomeDrive: "C:",
      HomePath: "\\Users\\native",
      AppData: "roaming",
      LocalAppData: "local",
      ProgramData: "shared",
      ProgramFiles: "programs",
      "ProgramFiles(x86)": "programs-x86",
      ProgramW6432: "programs-64",
      UserName: "native",
      UserDomain: "machine",
      PSModuleAnalysisCachePath: "C:\\synthetic\\ModuleAnalysisCache",
    };
    expect(
      resolveServiceManagerEnv({
        ...native,
        psmoduleanalysiscachepath: "C:\\ignored\\cache",
        PSModulePath: "C:\\untrusted-modules",
        PSExecutionPolicyPreference: "Bypass",
        NODE_OPTIONS: "--inspect",
        OPENCLAW_GATEWAY_TOKEN: "synthetic",
        BOUNDARY_APPLICATION: "synthetic",
      }),
    ).toEqual(native);
    expect(
      resolveServiceManagerEnv({
        PSModuleAnalysisCachePath: undefined,
        psmoduleanalysiscachepath: "C:\\ignored\\cache",
      }),
    ).toEqual({});
  });

  it.runIf(process.platform === "win32")(
    "preserves the caller's cache in native PowerShell and bounds fresh foreign PID queries",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-service-env-"));
      try {
        const cachePath = path.join(await fs.realpath(tempDir), "ModuleAnalysisCache");
        const excluded = {
          BOUNDARY_APPLICATION: "synthetic-application",
          OPENCLAW_GATEWAY_TOKEN: "synthetic-not-a-credential",
          NODE_OPTIONS: "--synthetic-injection-must-not-be-inherited",
        };
        // A separate source owns overrides even if the native block uses uppercase aliases.
        // Keep the real executable/account context; only the cache and controls are synthetic.
        const source = mergeProcessEnv([
          process.env,
          { PSModuleAnalysisCachePath: cachePath, ...excluded },
        ]);
        const env = { ...resolveServiceManagerEnv(source), LC_ALL: "C", TZ: "UTC" };
        await expect(fs.access(cachePath)).rejects.toMatchObject({ code: "ENOENT" });

        const beforeSpawn = Date.now();
        const child = spawn(
          process.execPath,
          ["-e", "process.stdin.resume(); process.send('ready');"],
          { env, stdio: ["pipe", "ignore", "ignore", "ipc"], windowsHide: true },
        );
        const closed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        try {
          const [message] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
          expect(message).toBe("ready");
          const readyAt = Date.now();
          const pid = child.pid;
          if (!pid) {
            throw new Error("expected the ready native child to have a PID");
          }
          expect(pid).not.toBe(process.pid);

          // Probe before the environment observation: no preparatory PowerShell/CIM warmup.
          // A foreign owned PID cannot succeed through the file-lock reader's self cache.
          const identities = ["first", "repeated"].map((attempt) => {
            const identity = readWindowsProcessStartTimeSync(pid, 1000, env);
            expect(identity, attempt).not.toBeNull();
            expect(identity, attempt).toBeGreaterThanOrEqual(beforeSpawn);
            expect(identity, attempt).toBeLessThanOrEqual(readyAt);
            return identity;
          });
          expect(identities[1]).toBe(identities[0]);

          const names = ["PSModuleAnalysisCachePath", ...Object.keys(excluded)];
          // CLR-only output avoids loading a serializer inside the inspection budget.
          // Base64 preserves path encoding; '-' distinguishes unset from present-empty.
          const fields = names.map(
            (name) =>
              `$value = [Environment]::GetEnvironmentVariable('${name}'); if ($null -eq $value) { [Console]::Out.WriteLine('-') } else { [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))) }`,
          );
          const observed = spawnSync(
            getWindowsPowerShellExePath(env),
            ["-NoProfile", "-NonInteractive", "-Command", fields.join("; ")],
            { env, encoding: "utf8", timeout: 1000, windowsHide: true, maxBuffer: 4096 },
          );
          expect(observed.error).toBeUndefined();
          expect(observed.status, observed.stderr).toBe(0);
          // Identity speed alone could pass with the host's default cache after dropping this key.
          expect(observed.stdout.trimEnd().split(/\r?\n/u)).toEqual([
            Buffer.from(cachePath, "utf8").toString("base64"),
            "-",
            "-",
            "-",
          ]);
        } finally {
          await stopChildProcess(child, 5_000);
          await closed;
        }
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
