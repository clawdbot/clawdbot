// Config CLI integration tests cover end-to-end config command reads and writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configRuntime from "../config/config.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import * as runtimeSchema from "../config/runtime-schema.js";
import { defaultRuntime } from "../runtime.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  registerConfigCli,
  runConfigGet,
  runConfigPatch,
  runConfigSet,
  runConfigUnset,
} from "./config-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const registeredRuntimeLogs: string[] = [];
const registeredRuntimeErrors: string[] = [];

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

function createTestRuntime() {
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

async function runRegisteredConfigCommand(args: string[]): Promise<void> {
  vi.spyOn(defaultRuntime, "log").mockImplementation((...values: unknown[]) => {
    registeredRuntimeLogs.push(values.map(String).join(" "));
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation((...values: unknown[]) => {
    registeredRuntimeErrors.push(values.map(String).join(" "));
  });
  vi.spyOn(defaultRuntime, "exit").mockImplementation((code: number) => {
    throw new Error(`__exit__:${code}`);
  });
  const program = new Command();
  program.exitOverride();
  registerConfigCli(program);
  await program.parseAsync(args, { from: "user" });
}

function installRuntimeSchemaReadHook(hook: () => void | Promise<void>): void {
  const readSchema = runtimeSchema.readBestEffortRuntimeConfigSchema;
  vi.spyOn(runtimeSchema, "readBestEffortRuntimeConfigSchema").mockImplementation(async () => {
    const result = await readSchema();
    await hook();
    return result;
  });
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

function createExecDryRunBatch(params: { markerPath: string }) {
  const response = JSON.stringify({
    protocolVersion: 1,
    values: {
      dryrun_id: "ok",
    },
  });
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(params.markerPath)}, "dryrun\\n", "utf8");`,
    `process.stdout.write(${JSON.stringify(response)});`,
  ].join("\n");
  const scriptPath = path.join(path.dirname(params.markerPath), "exec-provider.cjs");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return [
    {
      path: "secrets.providers.runner",
      provider: {
        source: "exec",
        command: scriptPath,
        trustedDirs: [path.dirname(scriptPath)],
        timeoutMs: 60_000,
        noOutputTimeoutMs: 60_000,
      },
    },
    {
      path: "channels.discord.token",
      ref: {
        source: "exec",
        provider: "runner",
        id: "dryrun_id",
      },
    },
  ];
}

async function withExecDryRunConfigHarness(
  prefix: string,
  run: (params: {
    batchPath: string;
    configPath: string;
    markerPath: string;
    runtime: ReturnType<typeof createTestRuntime>;
  }) => Promise<void>,
) {
  const tempDir = tempDirs.make(prefix);
  const configPath = path.join(tempDir, "openclaw.json");
  const batchPath = path.join(tempDir, "batch.json");
  const markerPath = path.join(tempDir, "marker.txt");
  const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_TEST_FAST"]);
  try {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          gateway: { port: 18789 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.writeFileSync(
      batchPath,
      `${JSON.stringify(createExecDryRunBatch({ markerPath }), null, 2)}\n`,
      "utf8",
    );

    setTestEnvValue("OPENCLAW_TEST_FAST", "1");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    clearConfigCache();
    clearRuntimeConfigSnapshot();

    await run({
      batchPath,
      configPath,
      markerPath,
      runtime: createTestRuntime(),
    });
  } finally {
    envSnapshot.restore();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
  }
}

describe("config cli integration", () => {
  afterEach(() => {
    registeredRuntimeLogs.length = 0;
    registeredRuntimeErrors.length = 0;
    vi.restoreAllMocks();
  });

  it("redacts SecretRef ids and plugin-only sensitive fields in JSON/text order", async () => {
    const secretRefId = "CONFIG_GET_TEST_TOKEN";
    const schemaOnlySecrets = ["first-private-route", "second-private-route"];
    await withConfigFileHarness(
      "openclaw-config-cli-get-redaction-",
      `${JSON.stringify(
        {
          channels: {
            discord: {
              enabled: false,
              token: { source: "env", provider: "default", id: secretRefId },
            },
          },
          plugins: {
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    headers: {
                      "X-First": schemaOnlySecrets[0],
                      "X-Second": schemaOnlySecrets[1],
                    },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      async () => {
        const output = createTestRuntime();
        await runConfigGet({ path: "channels.discord.token", json: true, runtime: output.runtime });
        await runConfigGet({ path: "channels.discord.token.id", runtime: output.runtime });
        await runConfigGet({
          path: "plugins.entries.codex.config.appServer.headers",
          json: true,
          runtime: output.runtime,
        });
        await runConfigGet({
          path: "plugins.entries.codex.config.appServer.headers",
          runtime: output.runtime,
        });

        expect(output.errors).toStrictEqual([]);
        expect(output.logs).toStrictEqual([
          JSON.stringify({ source: "env", provider: "default", id: REDACTED_SENTINEL }, null, 2),
          `${REDACTED_SENTINEL}\n`,
          JSON.stringify(REDACTED_SENTINEL),
          `${REDACTED_SENTINEL}\n`,
        ]);
        expect(output.logs.join("\n")).not.toContain(secretRefId);
        for (const secret of schemaOnlySecrets) {
          expect(output.logs.join("\n")).not.toContain(secret);
        }
      },
    );
  });

  it.each([
    {
      name: "plugin metadata is absent",
      installFailure: async () => {
        const snapshot = await configRuntime.readConfigFileSnapshot({ observe: false });
        vi.spyOn(configRuntime, "readConfigFileSnapshotWithPluginMetadata").mockResolvedValue({
          snapshot,
        });
      },
      expectedError: "plugin metadata unavailable",
    },
    {
      name: "schema construction fails",
      installFailure: async () => {
        vi.spyOn(runtimeSchema, "buildRuntimeConfigSchemaFromRegistry").mockImplementation(() => {
          throw new Error("schema construction unavailable");
        });
      },
      expectedError: "schema construction unavailable",
    },
  ])("fails closed before config get emits values when $name", async (testCase) => {
    await withConfigFileHarness(
      "openclaw-config-cli-get-fail-closed-",
      "{ gateway: { port: 19001 } }\n",
      async () => {
        await testCase.installFailure();
        const output = createTestRuntime();

        await expect(
          runConfigGet({ path: "gateway.port", runtime: output.runtime }),
        ).rejects.toThrow("__exit__:1");

        expect(output.logs).toStrictEqual([]);
        expect(output.errors.join("\n")).toContain(testCase.expectedError);
        expect(output.errors.join("\n")).not.toContain("19001");
      },
    );
  });

  it.each([
    {
      name: "set",
      expectedSource: "exec",
      run: (runtime: ReturnType<typeof createTestRuntime>["runtime"]) =>
        runConfigSet({
          path: "channels.discord.token",
          value: '{"source":"exec","provider":"shared","id":"discord/token"}',
          cliOptions: { strictJson: true },
          runtime,
        }),
    },
    {
      name: "unset",
      expectedSource: "env",
      run: (runtime: ReturnType<typeof createTestRuntime>["runtime"]) =>
        runConfigUnset({ path: "secrets.defaults.env", runtime }),
    },
  ])("rejects impossible provider/source refs during real config $name", async (testCase) => {
    const raw = `${JSON.stringify(
      {
        channels: {
          discord: {
            enabled: false,
            token: { source: "env", provider: "shared", id: "DISCORD_TEST_TOKEN" },
          },
        },
        secrets: {
          defaults: { env: "shared" },
          providers: {
            shared: { source: "file", path: "/tmp/openclaw-unused-secrets.json", mode: "json" },
          },
        },
      },
      null,
      2,
    )}\n`;
    await withConfigFileHarness(
      "openclaw-config-cli-source-mismatch-",
      raw,
      async ({ configPath }) => {
        const output = createTestRuntime();

        await expect(testCase.run(output.runtime)).rejects.toThrow("__exit__:1");

        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(output.errors.join("\n")).toContain(
          `provider "shared" has source "file" but ref requests "${testCase.expectedSource}"`,
        );
      },
    );
  });

  it("rejects impossible provider/source refs during real config patch", async () => {
    const raw = `${JSON.stringify(
      {
        channels: {
          discord: {
            enabled: false,
            token: { source: "env", provider: "shared", id: "DISCORD_TEST_TOKEN" },
          },
        },
        secrets: {
          defaults: { env: "shared" },
          providers: {
            shared: { source: "file", path: "/tmp/openclaw-unused-secrets.json", mode: "json" },
          },
        },
      },
      null,
      2,
    )}\n`;
    await withConfigFileHarness(
      "openclaw-config-cli-patch-source-mismatch-",
      raw,
      async ({ configPath, tempDir }) => {
        const patchPath = path.join(tempDir, "patch.json5");
        fs.writeFileSync(patchPath, "{ secrets: { defaults: { env: null } } }\n", "utf8");
        const output = createTestRuntime();

        await expect(
          runConfigPatch({ cliOptions: { file: patchPath }, runtime: output.runtime }),
        ).rejects.toThrow("__exit__:1");

        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(output.errors.join("\n")).toContain(
          'provider "shared" has source "file" but ref requests "env"',
        );
      },
    );
  });

  it("rejects impossible provider/source refs during real config validate", async () => {
    const refId = "DISCORD_TEST_TOKEN";
    await withConfigFileHarness(
      "openclaw-config-cli-validate-source-mismatch-",
      `${JSON.stringify(
        {
          channels: {
            discord: {
              enabled: false,
              token: { source: "exec", provider: "shared", id: refId },
            },
          },
          secrets: {
            providers: {
              shared: {
                source: "file",
                path: "/tmp/openclaw-unused-secrets.json",
                mode: "json",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      async () => {
        const snapshot = await configRuntime.readConfigFileSnapshot({ observe: false });
        expect(snapshot.valid).toBe(true);
        expect(snapshot.issues).toStrictEqual([]);

        await expect(runRegisteredConfigCommand(["config", "validate"])).rejects.toThrow(
          "__exit__:1",
        );

        expect(registeredRuntimeErrors.join("\n")).toContain(
          'Secret provider "shared" has source "file" but ref requests "exec"',
        );
        expect(registeredRuntimeErrors.join("\n")).not.toContain(refId);
      },
    );
  });

  it("allows a config set that repairs an inactive provider/source mismatch", async () => {
    const raw = `${JSON.stringify(
      {
        channels: {
          discord: {
            enabled: false,
            token: { source: "exec", provider: "shared", id: "discord/token" },
          },
        },
        secrets: {
          providers: {
            shared: { source: "file", path: "/tmp/openclaw-unused-secrets.json", mode: "json" },
          },
        },
      },
      null,
      2,
    )}\n`;
    await withConfigFileHarness(
      "openclaw-config-cli-repair-source-mismatch-",
      raw,
      async ({ configPath }) => {
        const output = createTestRuntime();

        await runConfigSet({
          path: "channels.discord.token",
          value: '{"source":"file","provider":"shared","id":"/discord/token"}',
          cliOptions: { strictJson: true },
          runtime: output.runtime,
        });

        expect(output.errors).toStrictEqual([]);
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
          channels: {
            discord: {
              token: { source: "file", provider: "shared", id: "/discord/token" },
            },
          },
        });
      },
    );
  });

  it.each([
    {
      name: "setting an authored value to itself",
      run: (runtime: ReturnType<typeof createTestRuntime>["runtime"]) =>
        runConfigSet({
          path: "gateway.port",
          value: "18789",
          cliOptions: { strictJson: true },
          runtime,
        }),
    },
    {
      name: "unsetting an absent authored value",
      run: (runtime: ReturnType<typeof createTestRuntime>["runtime"]) =>
        runConfigUnset({ path: "gateway.bind", runtime }),
    },
  ])("strictly validates an existing mismatch when $name is a no-op", async (testCase) => {
    const raw = `${JSON.stringify(
      {
        gateway: { port: 18789 },
        channels: {
          discord: {
            enabled: false,
            token: { source: "exec", provider: "shared", id: "discord/token" },
          },
        },
        secrets: {
          providers: {
            shared: { source: "file", path: "/tmp/openclaw-unused-secrets.json", mode: "json" },
          },
        },
      },
      null,
      2,
    )}\n`;
    await withConfigFileHarness(
      "openclaw-config-cli-noop-source-mismatch-",
      raw,
      async ({ configPath }) => {
        const output = createTestRuntime();

        await expect(testCase.run(output.runtime)).rejects.toThrow("__exit__:1");

        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(output.logs).not.toContain("No change");
        expect(output.errors.join("\n")).toContain(
          'provider "shared" has source "file" but ref requests "exec"',
        );
      },
    );
  });

  it("conflicts when a top-level include changes after config set starts", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-include-conflict-",
      '{ gateway: { $include: "./gateway.json5" } }\n',
      async ({ configPath, tempDir }) => {
        const includePath = path.join(tempDir, "gateway.json5");
        const concurrentRaw = '{ port: 19002, bind: "loopback" }\n';
        fs.writeFileSync(includePath, "{ port: 18789 }\n", "utf8");
        clearConfigCache();
        installRuntimeSchemaReadHook(() => {
          fs.writeFileSync(includePath, concurrentRaw, "utf8");
        });
        const output = createTestRuntime();

        await expect(
          runConfigSet({
            path: "gateway.port",
            value: "19001",
            cliOptions: { strictJson: true },
            runtime: output.runtime,
          }),
        ).rejects.toThrow("__exit__:1");

        expect(fs.readFileSync(configPath, "utf8")).toBe(
          '{ gateway: { $include: "./gateway.json5" } }\n',
        );
        expect(fs.readFileSync(includePath, "utf8")).toBe(concurrentRaw);
        expect(output.errors.join("\n")).toContain("included config changed since last load");
      },
    );
  });

  it("preserves exact JSON5 bytes when setting an authored value to itself", async () => {
    const raw =
      '{\n  // preserve this comment and order\n  gateway: { port: 18789 },\n  logging: { level: "info" },\n}\n';
    await withConfigFileHarness("openclaw-config-cli-noop-", raw, async ({ configPath }) => {
      const output = createTestRuntime();

      await runConfigSet({
        path: "gateway.port",
        value: "18789",
        cliOptions: { strictJson: true },
        runtime: output.runtime,
      });

      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      expect(output.errors).toStrictEqual([]);
      expect(output.logs).toStrictEqual(["No change"]);
    });
  });

  it("preserves exact JSON5 bytes while rejecting an absent authored unset", async () => {
    const raw =
      '{\n  // preserve this comment and order\n  gateway: { port: 18789 },\n  logging: { level: "info" },\n}\n';
    await withConfigFileHarness(
      "openclaw-config-cli-missing-unset-",
      raw,
      async ({ configPath }) => {
        const output = createTestRuntime();

        await expect(
          runConfigUnset({ path: "gateway.bind", runtime: output.runtime }),
        ).rejects.toThrow("__exit__:1");

        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(output.logs).toStrictEqual([]);
        expect(output.errors.join("\n")).toContain(
          "Config path not found: gateway.bind. Nothing was changed. Run openclaw config get <path> first if you are unsure of the path.",
        );
      },
    );
  });

  it("writes an absent key even when its value equals the resolved default", async () => {
    const raw = "{\n  // the default is not authored yet\n  gateway: {},\n}\n";
    await withConfigFileHarness(
      "openclaw-config-cli-default-equal-write-",
      raw,
      async ({ configPath }) => {
        const output = createTestRuntime();

        await runConfigSet({
          path: "gateway.port",
          value: "18789",
          cliOptions: { strictJson: true },
          runtime: output.runtime,
        });

        const after = fs.readFileSync(configPath, "utf8");
        expect(after).not.toBe(raw);
        expect(JSON5.parse(after)).toMatchObject({ gateway: { port: 18789 } });
        expect(output.logs.join("\n")).not.toContain("No change");
      },
    );
  });

  it("accepts plugin hook conversation-access policy via config set", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-plugin-hooks-"));
    const configPath = path.join(tempDir, "openclaw.json");
    const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_TEST_FAST"]);
    try {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            gateway: { port: 18789 },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      setTestEnvValue("OPENCLAW_TEST_FAST", "1");
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const runtime = createTestRuntime();
      await runConfigSet({
        path: "plugins.entries.openclaw-mem0.hooks.allowConversationAccess",
        value: "true",
        cliOptions: {},
        runtime: runtime.runtime,
      });

      expect(runtime.errors).toStrictEqual([]);
      const afterWrite = JSON5.parse(fs.readFileSync(configPath, "utf8"));
      expect(afterWrite.plugins?.entries?.["openclaw-mem0"]?.hooks).toEqual({
        allowConversationAccess: true,
      });
    } finally {
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("supports batch-file dry-run and then writes real config changes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-int-"));
    const configPath = path.join(tempDir, "openclaw.json");
    const batchPath = path.join(tempDir, "batch.json");
    const envSnapshot = captureEnv([
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_TEST_FAST",
      "DISCORD_BOT_TOKEN",
    ]);
    try {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            gateway: { port: 18789 },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      fs.writeFileSync(
        batchPath,
        `${JSON.stringify(
          [
            {
              path: "secrets.providers.default",
              provider: { source: "env" },
            },
            {
              path: "channels.discord.token",
              ref: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN",
              },
            },
          ],
          null,
          2,
        )}\n`,
        "utf8",
      );

      setTestEnvValue("OPENCLAW_TEST_FAST", "1");
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("DISCORD_BOT_TOKEN", "test-token");
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const runtime = createTestRuntime();
      const before = fs.readFileSync(configPath, "utf8");
      await runConfigSet({
        cliOptions: {
          batchFile: batchPath,
          dryRun: true,
        },
        runtime: runtime.runtime,
      });
      const afterDryRun = fs.readFileSync(configPath, "utf8");
      expect(afterDryRun).toBe(before);
      expect(runtime.errors).toStrictEqual([]);
      expect(runtime.logs.some((line) => line.includes("Dry run successful: 2 update(s)"))).toBe(
        true,
      );

      await runConfigSet({
        cliOptions: {
          batchFile: batchPath,
        },
        runtime: runtime.runtime,
      });
      const afterWrite = JSON5.parse(fs.readFileSync(configPath, "utf8"));
      expect(afterWrite.secrets?.providers?.default).toEqual({
        source: "env",
      });
      expect(afterWrite.channels?.discord?.token).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      });
    } finally {
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps file unchanged when real-file dry-run fails and reports JSON error payload", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-int-fail-"));
    const configPath = path.join(tempDir, "openclaw.json");
    const envSnapshot = captureEnv([
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_TEST_FAST",
      "MISSING_TEST_SECRET",
    ]);
    try {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            gateway: { port: 18789 },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      setTestEnvValue("OPENCLAW_TEST_FAST", "1");
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      deleteTestEnvValue("MISSING_TEST_SECRET");
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const runtime = createTestRuntime();
      const before = fs.readFileSync(configPath, "utf8");
      await expect(
        runConfigSet({
          path: "channels.discord.token",
          cliOptions: {
            refProvider: "default",
            refSource: "env",
            refId: "MISSING_TEST_SECRET",
            dryRun: true,
            json: true,
          },
          runtime: runtime.runtime,
        }),
      ).rejects.toThrow("__exit__:1");
      const after = fs.readFileSync(configPath, "utf8");
      expect(after).toBe(before);
      expect(runtime.errors).toStrictEqual([]);
      const raw = runtime.logs.at(-1);
      if (raw === undefined) {
        throw new Error("expected config check JSON log");
      }
      const payload = JSON.parse(raw) as {
        ok?: boolean;
        checks?: { schema?: boolean; resolvability?: boolean };
        errors?: Array<{ kind?: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.checks?.resolvability).toBe(true);
      expect(payload.errors?.some((entry) => entry.kind === "resolvability")).toBe(true);
      expect(
        payload.errors?.some((entry) => (entry.ref ?? "").includes("MISSING_TEST_SECRET")),
      ).toBe(true);
    } finally {
      envSnapshot.restore();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips exec provider execution during dry-run by default", async () => {
    await withExecDryRunConfigHarness("openclaw-config-cli-int-exec-skip-", async (params) => {
      const before = fs.readFileSync(params.configPath, "utf8");
      await runConfigSet({
        cliOptions: {
          batchFile: params.batchPath,
          dryRun: true,
        },
        runtime: params.runtime.runtime,
      });
      const after = fs.readFileSync(params.configPath, "utf8");

      expect(after).toBe(before);
      expect(fs.existsSync(params.markerPath)).toBe(false);
      expect(
        params.runtime.logs.some((line) =>
          line.includes("Dry run note: skipped 1 exec SecretRef resolvability check(s)."),
        ),
      ).toBe(true);
    });
  });

  it("executes exec providers during dry-run when --allow-exec is set", async () => {
    await withExecDryRunConfigHarness("openclaw-config-cli-int-exec-allow-", async (params) => {
      const before = fs.readFileSync(params.configPath, "utf8");
      await runConfigSet({
        cliOptions: {
          batchFile: params.batchPath,
          dryRun: true,
          allowExec: true,
        },
        runtime: params.runtime.runtime,
      });
      const after = fs.readFileSync(params.configPath, "utf8");

      expect(after).toBe(before);
      expect(fs.existsSync(params.markerPath)).toBe(true);
      expect(
        params.runtime.logs.some((line) =>
          line.includes("Dry run note: skipped 1 exec SecretRef resolvability check(s)."),
        ),
      ).toBe(false);
    });
  });
});
