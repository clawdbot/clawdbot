import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSystemdServiceExecStart,
  serializeSystemdEnvironmentFile,
} from "../../src/daemon/systemd-service-files.js";
import { buildSystemdUnit } from "../../src/daemon/systemd-unit.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const owner = resolve("scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh");

function fixture() {
  const home = tempDirs.make("survivor-manager-");
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
  return { home, env, shell, systemctl, unit };
}

describe.skipIf(process.platform === "win32")("survivor manager fixture", () => {
  it("distinguishes confirmed absence from unsupported inspection and reads the generated service", async () => {
    const { home, env, systemctl, unit } = fixture();
    // First install must reach the same effective reader used by the guarded writer.
    expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toBeNull();
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
    rmSync(unit);
    expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toBeNull();
  });

  it("executes the inspected argv, cwd and file environment, rejects an old survivor, and drains restart children", async () => {
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
    const records = (): Array<{ pid: number; argv: string[]; cwd: string; value: string }> =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    const waitForStarts = async (count: number) => {
      for (let attempt = 0; attempt < 200 && records().length < count; attempt++) {
        await delay(10);
      }
      expect(records()).toHaveLength(count);
    };
    try {
      expect(systemctl("enable", "openclaw-gateway.service").status).toBe(0);
      expect(systemctl("is-enabled", "openclaw-gateway.service").status).toBe(0);
      expect(
        shell("OPENCLAW_UPDATE_IN_PROGRESS=1 systemctl --user restart openclaw-gateway.service")
          .status,
      ).toBe(0);
      await waitForStarts(1);
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
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(existsSync(env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE)).toBe(false);
    }
  });
});
