import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function fixture() {
  const home = realpathSync(tempDirs.make("survivor-manager-"));
  const env = {
    HOME: home,
    PATH: `${home}/bin:${process.env.PATH}`,
    npm_config_prefix: home,
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(home, "systemctl.log"),
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(home, "gateway.pid"),
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: join(home, "gateway.log"),
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
  const installed = shell("install_update_restart_systemctl_shim");
  expect(installed.status, installed.stderr).toBe(0);
  const systemctl = (...args: string[]) =>
    spawnSync(join(home, "bin/systemctl"), ["--user", ...args], {
      env,
      encoding: "utf8",
      timeout: 40_000,
    });
  const unit = join(home, ".config/systemd/user/openclaw-gateway.service");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  const manager = (...args: string[]) =>
    spawnSync(process.execPath, [join(home, "bin/systemd-fixture.mjs"), ...args], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
  const execute = () => {
    const command = manager("command");
    expect(command.status, command.stderr).toBe(0);
    return spawnSync("bash", ["-c", command.stdout], { env, encoding: "utf8", timeout: 5_000 });
  };
  return { home, env, shell, systemctl, unit, manager, execute };
}

describe.skipIf(process.platform === "win32")("survivor manager fixture", () => {
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

  it.each(["plain", 'space "quoted" %h %%h', "trailing\\"])(
    "executes literal scalar paths through the copied fixture with cwd %j",
    async (directory) => {
      const { home, env, unit, manager, execute } = fixture();
      const workingDirectory = join(home, directory);
      const stateDirectory = join(home, 'state *?[ab](x)\\ "quoted" %h %%h');
      const alternateDirectory = join(home, 'state 12a(x) "quoted" %h %%h');
      for (const fixtureDirectory of [workingDirectory, stateDirectory, alternateDirectory]) {
        mkdirSync(fixtureDirectory, { recursive: true });
      }
      const environmentFile = join(stateDirectory, "gateway.systemd.env");
      const fileValue = 'file "quoted" \\ $literal `literal` %h %%h';
      const inlineValue = 'inline "quoted" \\ %h %%h';
      writeFileSync(environmentFile, serializeSystemdEnvironmentFile({ FIXTURE_VALUE: fileValue }));
      writeFileSync(
        join(alternateDirectory, "gateway.systemd.env"),
        serializeSystemdEnvironmentFile({ FIXTURE_VALUE: "wrong neighbor" }),
      );
      const program = join(home, "finite child.mjs");
      writeFileSync(
        program,
        "console.log(JSON.stringify({argv:process.argv.slice(2), cwd:process.cwd(), inline:process.env.FIXTURE_INLINE, value:process.env.FIXTURE_VALUE}));\n",
      );
      const programArguments = [process.execPath, program, 'argument "quoted" \\ %h %%h'];
      writeFileSync(
        unit,
        buildSystemdUnit({
          programArguments,
          workingDirectory,
          environment: { FIXTURE_INLINE: inlineValue, FIXTURE_VALUE: "inline fallback" },
          environmentFiles: [environmentFile],
        }),
      );
      const properties = manager(
        "busctl",
        "--user",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice",
        "org.freedesktop.systemd1.Service",
        "ExecStart",
        "WorkingDirectory",
        "Environment",
        "EnvironmentFiles",
        "UnsetEnvironment",
      );
      expect(properties.status, properties.stderr).toBe(0);
      expect(
        properties.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toContainEqual({
        type: "a(sb)",
        data: [
          [`${home}/state \\*\\?\\[ab\\]\\(x\\)\\\\ "quoted" %h %%h/gateway.systemd.env`, true],
        ],
      });
      expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toMatchObject({
        programArguments,
        workingDirectory,
        environment: { FIXTURE_INLINE: inlineValue, FIXTURE_VALUE: fileValue },
      });
      const child = execute();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        argv: programArguments.slice(2),
        cwd: workingDirectory,
        inline: inlineValue,
        value: fileValue,
      });
    },
  );

  it("preserves lexical dot-dot paths while executing through a symlink", async () => {
    const { home, env, unit, execute } = fixture();
    mkdirSync(join(home, "target/nested"), { recursive: true });
    mkdirSync(join(home, "target/cwd"));
    mkdirSync(join(home, "cwd"));
    symlinkSync(join(home, "target/nested"), join(home, "link"), "dir");
    // Joining or normalizing this spelling would select the tempting home/cwd instead.
    const workingDirectory = `${home}/link/../cwd`;
    writeFileSync(
      unit,
      buildSystemdUnit({
        programArguments: [process.execPath, "-p", "process.cwd()"],
        workingDirectory: `${workingDirectory}/.`,
      }),
    );
    expect.soft(await readSystemdServiceExecStart(env, { requireEffective: true })).toMatchObject({
      workingDirectory,
    });
    const child = execute();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe(join(home, "target/cwd"));
  });

  it("does not broaden a missing optional literal file and fails when it is required", () => {
    const { home, unit, manager, execute } = fixture();
    mkdirSync(join(home, "state-one"));
    writeFileSync(join(home, "state-one/gateway.systemd.env"), "FIXTURE_VALUE=wrong-neighbor\n");
    const content = buildSystemdUnit({
      programArguments: [process.execPath, "-p", "process.env.FIXTURE_VALUE"],
      environment: { FIXTURE_VALUE: "inline %h %%h" },
      environmentFiles: [join(home, "state*/gateway.systemd.env")],
    });
    writeFileSync(unit, content);
    const child = execute();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("inline %h %%h");
    writeFileSync(unit, content.replace("EnvironmentFile=-", "EnvironmentFile="));
    expect(manager("reload").status).toBe(0);
    const required = manager("command");
    expect(required.status).not.toBe(0);
    expect(required.stderr).toContain("ENOENT");
  });

  it.each(["*.env", "?.env", "[ab].env", "dangling\\", "unknown\\q"])(
    "rejects unsupported EnvironmentFile pattern %j visibly",
    (pattern) => {
      const { home, unit, manager } = fixture();
      writeFileSync(
        unit,
        buildSystemdUnit({ programArguments: [process.execPath, "-p", "process.cwd()"] }).replace(
          "[Service]",
          `[Service]\nEnvironmentFile=-${home}/${pattern}`,
        ),
      );
      const load = manager("load-state");
      expect(load.status).not.toBe(0);
      expect(load.stderr).toContain("Unsupported");
      const command = manager("command");
      expect(command.status).not.toBe(0);
      expect(command.stderr).toContain("Unsupported");
    },
  );

  it("keeps the inspected service alive after the caller terminal closes and drains restart children", async () => {
    const { home, env, shell, systemctl, unit } = fixture();
    const record = join(home, "starts.jsonl");
    const program = join(home, "gateway fixture.mjs");
    const environmentFile = join(home, "gateway.systemd.env");
    const fileValue = 'file "quoted" \\ $literal `literal`';
    writeFileSync(environmentFile, serializeSystemdEnvironmentFile({ FIXTURE_VALUE: fileValue }));
    writeFileSync(
      program,
      `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid, argv:process.argv.slice(2), cwd:process.cwd(), value:process.env.FIXTURE_VALUE, state:process.env.OPENCLAW_STATE_DIR, update:process.env.OPENCLAW_UPDATE_IN_PROGRESS}) + "\\n");
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
status = pty.spawn(["bash", "-c", sys.argv[1], "fixture", sys.argv[2]], stdin_read=lambda _: b"")
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
      expect(restarted.status, restarted.stderr).toBe(0);
      await waitForStarts(1);
      expect.soft(systemctl("is-active", "openclaw-gateway.service").status).toBe(0);
      const inspected = await readSystemdServiceExecStart(env, { requireEffective: true });
      expect(records()[0]).toEqual({
        pid: expect.any(Number),
        argv: inspected?.programArguments.slice(2),
        cwd: inspected?.workingDirectory,
        value: inspected?.environment?.FIXTURE_VALUE,
        state: join(home, "state"),
      });
      const previousPid = readFileSync(
        env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE,
        "utf8",
      ).trim();
      expect(await readSystemdServiceRuntime(env)).toMatchObject({
        status: "running",
        pid: Number(previousPid),
      });
      const previousLines = readFileSync(env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG, "utf8")
        .trim()
        .split("\n").length;
      const assertion = () =>
        shell('assert_update_restart_service_replaced "$1" "$2"', [
          previousPid,
          String(previousLines),
        ]);
      expect(assertion().status).not.toBe(0);
      expect(systemctl("restart", "openclaw-gateway.service").status).toBe(0);
      await waitForStarts(2);
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
      expect(existsSync(env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE)).toBe(false);
      const runtime = await readSystemdServiceRuntime(env);
      expect(runtime).toMatchObject({ status: "stopped" });
      expect(runtime.missingUnit).not.toBe(true);
    }
  });
});
