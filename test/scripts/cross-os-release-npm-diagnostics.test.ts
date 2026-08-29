import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("../../scripts/lib/cross-os-release-checks/process.ts", () => mocks);

import { installPackageSpec } from "../../scripts/lib/cross-os-release-checks/install.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => mocks.runCommand.mockReset());

function fixture() {
  const rootDir = tempDirs.make("cross-os-npm-diagnostics-");
  const homeDir = join(rootDir, "home");
  const logsDir = join(homeDir, ".npm", "_logs");
  mkdirSync(logsDir, { recursive: true });
  return {
    lane: {
      name: "upgrade",
      rootDir,
      prefixDir: join(rootDir, "prefix"),
      homeDir,
      stateDir: join(homeDir, ".openclaw"),
      appDataDir: join(homeDir, "AppData"),
      gatewayPort: 0,
      phaseTimings: [],
    },
    env: { npm_config_logs_dir: logsDir },
    packageSpec: "openclaw@2026.7.1-2",
    logPath: join(rootDir, "install.log"),
    logsDir,
  };
}

function diagnostics(logPath: string) {
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const record = log.match(/^\[release-checks\] npm-diagnostics (.+)$/mu)?.[1];
  expect(record, "phase must retain npm diagnostics").toBeDefined();
  return JSON.parse(record!);
}

describe("cross-OS npm diagnostic capture", () => {
  it("retains only numeric and allowlisted observations after a successful install", async () => {
    const params = fixture();
    const secret = "credential-sentinel-must-never-be-exported";
    mocks.runCommand.mockImplementation(async () => {
      writeFileSync(
        join(params.logsDir, "2026-08-29T00_00_00_000Z-debug-0.log"),
        [
          `0 verbose title npm install https://user:${secret}@registry.test/package.tgz`,
          `1 http fetch GET 200 https://registry.test/?token=${secret} 123ms (cache miss)`,
          "2 http cache https://registry.test/public 5ms (cache hit)",
          "3 timing reify:unpack Completed in 200ms",
          `4 timing reifyNode:${secret} Completed in 999ms`,
          `5 error ${secret}`,
          "6 verbose exit 0",
          "7 timing reify:build Completed in 999999999999999999ms",
          "8 timing reify:trash Completed in -1ms",
          `9 error code ${secret}`,
          `10 verbose title npm ${secret}`,
        ].join("\n"),
      );
      return { exitCode: 0, stdout: "installed", stderr: "" };
    });

    await installPackageSpec(params);

    expect(diagnostics(params.logPath)).toMatchObject({
      logs: [
        {
          command: "install",
          exitCode: 0,
          fetch: { count: 2, cacheHits: 1, cacheMisses: 1, durationMs: 128, maxDurationMs: 123 },
          timings: { "reify:unpack": 200 },
        },
      ],
    });
    const output = readFileSync(params.logPath, "utf8");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("registry.test");
    expect(output).not.toContain(params.logsDir);
    expect(output).not.toContain("reifyNode");
    expect(diagnostics(params.logPath).logs[0].timings).toEqual({ "reify:unpack": 200 });
  });

  it("captures a failed command without replacing its error or copying raw diagnostic text", async () => {
    const params = fixture();
    const failure = new Error("install failed");
    mocks.runCommand.mockImplementation(async () => {
      writeFileSync(
        join(params.logsDir, "2026-08-29T00_00_00_000Z-debug-0.log"),
        "0 error code ETIMEDOUT\n1 error password=credential-sentinel\n2 verbose exit 1\n",
      );
      throw failure;
    });

    await expect(installPackageSpec(params)).rejects.toBe(failure);
    expect(diagnostics(params.logPath)).toMatchObject({
      logs: [{ errorCodes: ["ETIMEDOUT"], exitCode: 1 }],
    });
    expect(readFileSync(params.logPath, "utf8")).not.toContain("credential-sentinel");
  });

  it("ignores stale process logs and bounds the retained tail and process count", async () => {
    const params = fixture();
    writeFileSync(join(params.logsDir, "stale-debug-0.log"), "0 error code EACCES\n");
    mocks.runCommand.mockImplementation(async () => {
      for (let index = 0; index < 12; index++) {
        writeFileSync(
          join(
            params.logsDir,
            `2026-08-29T00_00_${String(index).padStart(2, "0")}_000Z-debug-0.log`,
          ),
          `0 error code ENOSPC\n${"credential-sentinel\n".repeat(20_000)}1 error code EPERM\n`,
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await installPackageSpec(params);
    const result = diagnostics(params.logPath);
    expect(result.truncated).toBe(true);
    expect(result.logs).toHaveLength(8);
    expect(
      result.logs.every(
        (log: { truncated: boolean; errorCodes: string[] }) =>
          log.truncated && log.errorCodes.join() === "EPERM",
      ),
    ).toBe(true);
    expect(Buffer.byteLength(readFileSync(params.logPath, "utf8"))).toBeLessThan(16 * 1024);
  });

  it("does not fail installation when npm logs are unavailable", async () => {
    const params = fixture();
    params.env.npm_config_logs_dir = join(params.lane.rootDir, "not-a-directory");
    writeFileSync(params.env.npm_config_logs_dir, "not a directory");
    mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await expect(installPackageSpec(params)).resolves.toBeUndefined();
    expect(diagnostics(params.logPath)).toMatchObject({ logs: [] });
  });

  it("attributes only newly appended and rotated log records to the next phase", async () => {
    const params = fixture();
    const npmLogPath = join(params.logsDir, "2026-08-29T00_00_00_000Z-debug-0.log");
    mocks.runCommand
      .mockImplementationOnce(async () => {
        writeFileSync(npmLogPath, "0 error code EPERM\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        appendFileSync(npmLogPath, "1 error code ETIMEDOUT\n");
        writeFileSync(npmLogPath.replace("debug-0", "debug-1"), "2 verbose exit 1\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    await installPackageSpec(params);
    const nextLogPath = join(params.lane.rootDir, "next-install.log");
    await installPackageSpec({ ...params, logPath: nextLogPath });

    expect(diagnostics(params.logPath).logs[0].errorCodes).toEqual(["EPERM"]);
    expect(diagnostics(nextLogPath).logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorCodes: ["ETIMEDOUT"] }),
        expect.objectContaining({ exitCode: 1 }),
      ]),
    );
    expect(readFileSync(nextLogPath, "utf8")).not.toContain("EPERM");
  });
});
