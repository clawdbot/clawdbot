import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { registerConfigCli } from "./config-cli.js";

// Config mutation owns these assertions; plugin discovery suites own registry breadth.
// Keep the real schemas this suite exercises, but build their metadata only once.
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>();
  let snapshot: ReturnType<typeof actual.loadPluginMetadataSnapshot> | undefined;
  return {
    ...actual,
    resolvePluginMetadataSnapshot: (
      params: Parameters<typeof actual.resolvePluginMetadataSnapshot>[0],
    ) => {
      snapshot ??= actual.loadPluginMetadataSnapshot({
        ...params,
        pluginIds: ["codex", "discord", "openclaw-mem0"],
        pluginIdScope: undefined,
      });
      return snapshot;
    },
  };
});

export function createTestRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    runtime: {
      log: (...args: unknown[]) => logs.push(args.map((arg) => String(arg)).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map((arg) => String(arg)).join(" ")),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    },
  };
}

export function useConfigCliIntegrationHarness() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const registeredRuntimeLogs: string[] = [];
  const registeredRuntimeErrors: string[] = [];
  afterEach(() => {
    registeredRuntimeLogs.length = 0;
    registeredRuntimeErrors.length = 0;
    vi.restoreAllMocks();
  });

  async function runRegisteredConfigCommand(args: string[]): Promise<void> {
    vi.spyOn(defaultRuntime, "log").mockImplementation((...values: unknown[]) => {
      registeredRuntimeLogs.push(values.map(String).join(" "));
    });
    vi.spyOn(defaultRuntime, "error").mockImplementation((...values: unknown[]) => {
      registeredRuntimeErrors.push(values.map(String).join(" "));
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code: number) => {
      throw new Error(`__exit__:${code}: ${registeredRuntimeErrors.at(-1) ?? ""}`);
    });
    const program = new Command();
    program.exitOverride();
    registerConfigCli(program);
    await program.parseAsync(args, { from: "user" });
  }

  async function withConfigFileHarness(
    prefix: string,
    raw: string,
    run: (params: { configPath: string; tempDir: string }) => Promise<void>,
  ): Promise<void> {
    const tempDir = tempDirs.make(prefix);
    const configPath = path.join(tempDir, "openclaw.json");
    const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_TEST_FAST"]);
    try {
      fs.writeFileSync(configPath, raw, "utf8");
      setTestEnvValue("OPENCLAW_TEST_FAST", "1");
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await run({ configPath, tempDir });
    } finally {
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
    }
  }

  return {
    registeredRuntimeLogs,
    registeredRuntimeErrors,
    runRegisteredConfigCommand,
    withConfigFileHarness,
  };
}
