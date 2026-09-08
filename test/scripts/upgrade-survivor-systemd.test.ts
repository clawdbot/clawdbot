import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readSystemdServiceRuntime } from "../../src/daemon/systemd-runtime.js";
import {
  readSystemdServiceExecStart,
  serializeSystemdEnvironmentFile,
} from "../../src/daemon/systemd-service-files.js";
import { buildSystemdUnit } from "../../src/daemon/systemd-unit.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const owner = resolve("scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh");

function fixture(customPaths = true, registry?: string, managerSetup = "") {
  const home = tempDirs.make("survivor-manager-");
  const artifacts = join(home, customPaths ? "artifacts ' \" $ `" : "bin");
  mkdirSync(artifacts, { recursive: true });
  const paths = {
    log: join(artifacts, "systemctl-shim.log"),
    pid: join(artifacts, "systemctl-shim.pid"),
    daemonLog: join(artifacts, "systemctl-shim-gateway.log"),
  };
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${home}/bin:${process.env.PATH}`,
    npm_config_prefix: home,
    NPM_CONFIG_REGISTRY: registry,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: customPaths ? paths.log : undefined,
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: customPaths ? paths.pid : undefined,
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: customPaths ? paths.daemonLog : undefined,
  };
  const shell = (script: string, args: string[] = []) =>
    spawnSync(
      "bash",
      ["-c", 'set -euo pipefail; source "$1"; shift; ' + script, "fixture", owner, ...args],
      {
        env,
        encoding: "utf8",
        timeout: 40_000,
      },
    );
  const installed = shell(`${managerSetup}\ninstall_update_restart_systemctl_shim`);
  expect(installed.status, installed.stderr).toBe(0);
  const systemctl = (...args: string[]) =>
    spawnSync(join(home, "bin/systemctl"), ["--user", ...args], {
      env,
      encoding: "utf8",
      timeout: 40_000,
    });
  const unit = join(home, ".config/systemd/user/openclaw-gateway.service");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  return { home, env, shell, systemctl, unit, paths };
}

describe.skipIf(process.platform === "win32")("survivor manager fixture", () => {
  it("keeps self-upgrade target channels enabled despite historical source suppression", async () => {
    const lane = readFileSync(
      resolve("scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh"),
      "utf8",
    );
    const setup = lane.slice(lane.indexOf("export CI=true"), lane.indexOf("SOURCE_VERSION="));
    const { home, systemctl, unit } = fixture(true, undefined, setup);
    const record = join(home, "target-env.json");
    const program = join(home, "target.mjs");
    writeFileSync(
      program,
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({providers:process.env.OPENCLAW_SKIP_PROVIDERS ?? null, channels:process.env.OPENCLAW_SKIP_CHANNELS ?? null}));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      unit,
      buildSystemdUnit({ programArguments: [process.execPath, program], workingDirectory: home }),
    );
    try {
      expect(systemctl("start", "openclaw-gateway.service").status).toBe(0);
      await expect.poll(() => existsSync(record)).toBe(true);
      expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ providers: null, channels: null });
    } finally {
      expect(systemctl("stop", "openclaw-gateway.service").status).toBe(0);
    }
  });

  it("distinguishes confirmed absence from unsupported inspection and reads the generated service", async () => {
    const { home, env, systemctl, unit } = fixture();
    // First install must reach the same effective reader used by the guarded writer.
    expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toBeNull();
    expect(await readSystemdServiceRuntime(env)).toMatchObject({
      status: "stopped",
      missingUnit: true,
    });
    expect(systemctl("is-enabled", "openclaw-gateway.service").status).not.toBe(0);
    const environmentFile = join(home, "gateway.systemd.env");
    writeFileSync(environmentFile, 'FIXTURE_VALUE="from file"\n');
    const programArguments = [
      process.execPath,
      join(home, "package root/openclaw.mjs"),
      "gateway",
      "--port",
      "18817",
    ];
    writeFileSync(
      unit,
      buildSystemdUnit({
        programArguments,
        workingDirectory: home,
        environment: {
          OPENCLAW_STATE_DIR: join(home, "state"),
          OPENCLAW_GATEWAY_PORT: "18817",
          FIXTURE_VALUE: "inline",
        },
        environmentFiles: [environmentFile],
      }),
    );
    const command = await readSystemdServiceExecStart(env, { requireEffective: true });
    const stoppedRuntime = await readSystemdServiceRuntime(env);
    expect(stoppedRuntime).toMatchObject({
      status: "stopped",
      state: "inactive",
      systemd: { unit: "openclaw-gateway.service" },
    });
    expect(stoppedRuntime.missingUnit).not.toBe(true);
    // Published 8.1 omits LoadState from its runtime query during baseline bootstrap.
    const legacyRuntime = systemctl(
      "show",
      "openclaw-gateway.service",
      "--property",
      "Id,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
    );
    expect(legacyRuntime.status, legacyRuntime.stderr).toBe(0);
    expect(legacyRuntime.stdout).toContain("ActiveState=inactive");
    expect(command).toMatchObject({
      programArguments,
      workingDirectory: home,
      sourcePath: unit,
      definitionPaths: [unit],
      environment: {
        OPENCLAW_STATE_DIR: join(home, "state"),
        OPENCLAW_GATEWAY_PORT: "18817",
        FIXTURE_VALUE: "from file",
      },
      environmentValueSources: { FIXTURE_VALUE: "inline-and-file" },
    });
    const peer = fixture();
    writeFileSync(peer.unit, buildSystemdUnit({ programArguments: ["/usr/bin/peer", "gateway"] }));
    expect(await readSystemdServiceExecStart(peer.env, { requireEffective: true })).toMatchObject({
      programArguments: ["/usr/bin/peer", "gateway"],
      sourcePath: peer.unit,
    });
    expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toEqual(command);
    const invalid = spawnSync(
      join(home, "bin/busctl"),
      ["--user", "--json=short", "call", "unsupported"],
      { env, encoding: "utf8" },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).not.toContain("not found");
    expect(systemctl("show", "openclaw-gateway.service", "--property=Unsupported").status).not.toBe(
      0,
    );

    writeFileSync(
      unit,
      buildSystemdUnit({ programArguments: [...programArguments.slice(0, -1), "18818"] }),
    );
    expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toMatchObject({
      programArguments,
      reloadPending: true,
    });
    expect(systemctl("daemon-reload").status).toBe(0);
    expect(
      (await readSystemdServiceExecStart(env, { requireEffective: true }))?.programArguments.at(-1),
    ).toBe("18818");
    writeFileSync(
      unit,
      readFileSync(unit, "utf8").replace("[Service]", "[Service]\nExecStartPre=/bin/true"),
    );
    await expect(readSystemdServiceExecStart(env, { requireEffective: true })).rejects.toThrow(
      "could not be inspected",
    );
    expect(await readSystemdServiceRuntime(env)).toMatchObject({ status: "unknown" });
    rmSync(unit);
    expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toBeNull();
    expect(await readSystemdServiceRuntime(env)).toMatchObject({
      status: "stopped",
      missingUnit: true,
    });
  });

  it("keeps the inspected service alive after the caller terminal closes and drains restart children", async () => {
    const registry = "http://127.0.0.1:41731";
    const { home, env, shell, systemctl, unit, paths } = fixture(true, registry);
    env.NPM_CONFIG_REGISTRY = undefined;
    env.OPENCLAW_SKIP_CHANNELS = undefined;
    env.OPENCLAW_SKIP_PROVIDERS = undefined;
    env.OPENCLAW_DISABLE_BONJOUR = undefined;
    const record = join(home, "starts.jsonl");
    const program = join(home, "gateway fixture.mjs");
    const environmentFile = join(home, "gateway.systemd.env");
    const fileValue = 'file "quoted" \\ $literal `literal`';
    writeFileSync(environmentFile, serializeSystemdEnvironmentFile({ FIXTURE_VALUE: fileValue }));
    writeFileSync(
      program,
      `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid, argv:process.argv.slice(2), cwd:process.cwd(), value:process.env.FIXTURE_VALUE, state:process.env.OPENCLAW_STATE_DIR, update:process.env.OPENCLAW_UPDATE_IN_PROGRESS, npmRegistry:process.env.NPM_CONFIG_REGISTRY, npmLowerRegistry:process.env.npm_config_registry, bunRegistry:process.env.BUN_CONFIG_REGISTRY, skipChannels:process.env.OPENCLAW_SKIP_CHANNELS, skipProviders:process.env.OPENCLAW_SKIP_PROVIDERS, disableBonjour:process.env.OPENCLAW_DISABLE_BONJOUR}) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    const programArguments = [
      process.execPath,
      program,
      "gateway",
      "--port",
      "18819",
      "literal $notExpanded",
    ];
    writeFileSync(
      unit,
      buildSystemdUnit({
        programArguments,
        workingDirectory: home,
        environment: { OPENCLAW_STATE_DIR: join(home, "state"), FIXTURE_VALUE: "inline" },
        environmentFiles: [environmentFile],
      }),
    );
    const records = (): Array<{ pid: number; argv: string[]; cwd: string; value: string }> => {
      if (!existsSync(record)) {
        return [];
      }
      // The restarted service appends one JSON record per line while this poller reads
      // concurrently, so a read landing mid-append sees a torn final line. Only whole
      // newline-terminated records count as observed starts; an unterminated tail is
      // dropped so the poll retries instead of throwing. Earlier lines are always
      // complete, so a parse failure there still fails the test.
      const lines = readFileSync(record, "utf8").split("\n");
      if (lines.at(-1) !== "") {
        lines.pop();
      }
      return lines.filter((line) => line !== "").map((line) => JSON.parse(line));
    };
    const waitForStarts = async (count: number) => {
      for (let attempt = 0; attempt < 200 && records().length < count; attempt++) {
        await delay(10);
      }
      expect(records()).toHaveLength(count);
    };
    try {
      expect(systemctl("enable", "openclaw-gateway.service").status).toBe(0);
      expect(systemctl("is-enabled", "openclaw-gateway.service").status).toBe(0);
      const restarted = spawnSync(
        "python3",
        [
          "-c",
          `import os, pty, sys
def read_terminal(fd):
    data = os.read(fd, 1024)
    # Python 3.9 loops after macOS EOF; use its Linux terminal-close cleanup path.
    if not data:
        raise OSError("terminal closed")
    return data
status = pty.spawn(["bash", "-c", sys.argv[1], "fixture", sys.argv[2]], master_read=read_terminal, stdin_read=lambda _: b"")
code = os.waitstatus_to_exitcode(status)
raise SystemExit(code if code >= 0 else 128 - code)
`,
          'set -e; systemctl --user restart openclaw-gateway.service; for _ in {1..200}; do [ -s "$1" ] && exit 0; sleep 0.01; done; exit 1',
          record,
        ],
        {
          env: { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
          encoding: "utf8",
          timeout: 40_000,
        },
      );
      expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);
      await waitForStarts(1);
      expect.soft(systemctl("is-active", "openclaw-gateway.service").status).toBe(0);
      const inspected = await readSystemdServiceExecStart(env, { requireEffective: true });
      expect(records()[0]).toEqual({
        pid: expect.any(Number),
        argv: inspected?.programArguments.slice(2),
        cwd: inspected?.workingDirectory,
        value: inspected?.environment?.FIXTURE_VALUE,
        state: join(home, "state"),
        npmRegistry: registry,
        npmLowerRegistry: registry,
        bunRegistry: registry,
        skipChannels: "1",
        skipProviders: "1",
        disableBonjour: "1",
      });
      const previousPid = readFileSync(paths.pid, "utf8").trim();
      expect(await readSystemdServiceRuntime(env)).toMatchObject({
        status: "running",
        pid: Number(previousPid),
      });
      const previousLines = readFileSync(paths.log, "utf8").trim().split("\n").length;
      const assertion = () =>
        shell('assert_update_restart_service_replaced "$1" "$2"', [
          previousPid,
          String(previousLines),
        ]);
      expect(assertion().status).not.toBe(0);
      env.NPM_CONFIG_REGISTRY = "http://127.0.0.1:41732";
      env.OPENCLAW_SKIP_CHANNELS = "0";
      env.OPENCLAW_SKIP_PROVIDERS = "0";
      env.OPENCLAW_DISABLE_BONJOUR = "0";
      expect(systemctl("restart", "openclaw-gateway.service").status).toBe(0);
      await waitForStarts(2);
      expect(records()[1]).toMatchObject({
        npmRegistry: registry,
        npmLowerRegistry: registry,
        bunRegistry: registry,
        skipChannels: "1",
        skipProviders: "1",
        disableBonjour: "1",
      });
      const proof = assertion();
      expect(proof.status, proof.stderr).toBe(0);
      expect(records()[1]?.pid).not.toBe(records()[0]?.pid);
      expect(() => process.kill(records()[0]!.pid, 0)).toThrow();
    } finally {
      const stopped = systemctl("stop", "openclaw-gateway.service");
      expect(stopped.status, stopped.stderr).toBe(0);
      for (const { pid } of records()) {
        try {
          expect.soft(() => process.kill(pid, 0)).toThrow();
        } finally {
          // A broken supervisor can strand its detached child; keep failed proof isolated.
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      expect(existsSync(paths.pid)).toBe(false);
      const runtime = await readSystemdServiceRuntime(env);
      expect(runtime).toMatchObject({ status: "stopped" });
      expect(runtime.missingUnit).not.toBe(true);
    }
  });

  it.each([true, false])(
    "binds installation paths for direct and native clients (custom=%s)",
    async (custom) => {
      const { home, env, unit, paths } = fixture(custom);
      writeFileSync(unit, buildSystemdUnit({ programArguments: ["/usr/bin/fixture", "gateway"] }));
      writeFileSync(paths.pid, `${process.pid}\n`);
      writeFileSync(`${paths.daemonLog}.exit.json`, JSON.stringify({ last: { code: 78 } }));
      const driftedEnv = {
        ...env,
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(home, "wrong.log"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(home, "wrong.pid"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: join(home, "wrong-daemon.log"),
      };
      const direct = spawnSync(
        join(home, "bin/systemctl"),
        [
          "--user",
          "show",
          "openclaw-gateway.service",
          "--property=Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
        ],
        { env: driftedEnv, encoding: "utf8" },
      );
      expect(direct.status, direct.stderr).toBe(0);
      expect(direct.stdout).toContain(`MainPID=${process.pid}`);
      expect(direct.stdout).toContain("ExecMainStatus=78");
      expect(await readSystemdServiceRuntime(driftedEnv)).toMatchObject({
        status: "running",
        pid: process.pid,
        lastExitStatus: 78,
      });
      expect(readFileSync(paths.log, "utf8")).toContain("--user show openclaw-gateway.service");
      expect(existsSync(driftedEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG)).toBe(false);
      // This is an observation-only PID fixture; never send stop to the test worker.
      rmSync(paths.pid);
    },
  );
});
