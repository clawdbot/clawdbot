// Config secret integration tests cover final-candidate validation and provider execution.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

// Register the harness metadata mock before loading the real config and command modules.
const configRuntime = await import("../config/config.js");
const { runConfigPatch, runConfigSet, runConfigUnset } = await import("./config-cli.js");
const { registeredRuntimeErrors, runRegisteredConfigCommand, withConfigFileHarness } =
  useConfigCliIntegrationHarness();

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
  await withConfigFileHarness(
    prefix,
    `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`,
    async ({ configPath, tempDir }) => {
      const batchPath = path.join(tempDir, "batch.json");
      const markerPath = path.join(tempDir, "marker.txt");
      fs.writeFileSync(
        batchPath,
        `${JSON.stringify(createExecDryRunBatch({ markerPath }), null, 2)}\n`,
        "utf8",
      );
      await run({ batchPath, configPath, markerPath, runtime: createTestRuntime() });
    },
  );
}

describe("config cli secrets integration", () => {
  it.each(["agents.defaults", "agents.entries.ops"])(
    "validates SecretRefs after normalizing model keys in %s",
    async (agentPath) => {
      const raw = '{ secrets: { providers: { default: { source: "env" } } } }\n';
      await withConfigFileHarness(
        "openclaw-config-cli-normalized-model-ref-",
        raw,
        async ({ configPath }) => {
          const envSnapshot = captureEnv(["MISSING_TEST_SECRET"]);
          try {
            deleteTestEnvValue("MISSING_TEST_SECRET");
            const output = createTestRuntime();

            await expect(
              runConfigSet({
                path: `${agentPath}.models["google/gemini-3-flash"].params.authorization`,
                value: JSON.stringify({
                  source: "env",
                  provider: "default",
                  id: "MISSING_TEST_SECRET",
                }),
                cliOptions: { strictJson: true, dryRun: true, json: true },
                runtime: output.runtime,
              }),
            ).rejects.toThrow("__exit__:1");

            expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
              ok: false,
              refsChecked: 1,
              errors: [{ kind: "resolvability", ref: "env:default:MISSING_TEST_SECRET" }],
            });
          } finally {
            envSnapshot.restore();
          }
        },
      );
    },
  );

  it("keeps model provider ids separate from SecretRef provider aliases", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-model-provider-alias-",
      "{}\n",
      async ({ configPath, tempDir }) => {
        const raw = JSON.stringify({
          models: {
            providers: {
              openai: { baseUrl: "https://example.invalid/v1", models: [] },
            },
          },
          secrets: {
            providers: {
              openai: { source: "exec", command: path.join(tempDir, "missing-helper") },
            },
          },
        });
        fs.writeFileSync(configPath, raw);
        const envSnapshot = captureEnv(["MODEL_API_KEY"]);
        try {
          setTestEnvValue("MODEL_API_KEY", "test-model-key");
          const output = createTestRuntime();

          await runConfigSet({
            path: "models.providers.openai.apiKey",
            cliOptions: {
              refProvider: "default",
              refSource: "env",
              refId: "MODEL_API_KEY",
              dryRun: true,
              json: true,
            },
            runtime: output.runtime,
          });

          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(output.errors).toEqual([]);
          expect(JSON.parse(output.logs.join("\n"))).toMatchObject({ ok: true, refsChecked: 1 });
        } finally {
          envSnapshot.restore();
        }
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

        await expect(runRegisteredConfigCommand(["config", "validate"])).rejects.toMatchObject({
          name: "ExitError",
          code: 1,
        });

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

  it("supports batch-file dry-run and then writes real config changes", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-int-",
      "{ gateway: { port: 18789 } }\n",
      async ({ configPath, tempDir }) => {
        const envSnapshot = captureEnv(["DISCORD_BOT_TOKEN"]);
        try {
          setTestEnvValue("DISCORD_BOT_TOKEN", "test-token");
          const batchPath = path.join(tempDir, "batch.json");
          fs.writeFileSync(
            batchPath,
            JSON.stringify([
              { path: "secrets.providers.default", provider: { source: "env" } },
              {
                path: "channels.discord.token",
                ref: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
              },
            ]),
            "utf8",
          );
          const output = createTestRuntime();
          const before = fs.readFileSync(configPath, "utf8");
          await runConfigSet({
            cliOptions: { batchFile: batchPath, dryRun: true },
            runtime: output.runtime,
          });

          expect(fs.readFileSync(configPath, "utf8")).toBe(before);
          expect(output.errors).toStrictEqual([]);
          expect(output.logs.join("\n")).toContain("Dry run successful: 2 update(s)");

          await runConfigSet({
            cliOptions: { batchFile: batchPath },
            runtime: output.runtime,
          });
          const afterWrite = JSON5.parse(fs.readFileSync(configPath, "utf8"));
          expect(afterWrite.secrets?.providers?.default).toEqual({ source: "env" });
          expect(afterWrite.channels?.discord?.token).toEqual({
            source: "env",
            provider: "default",
            id: "DISCORD_BOT_TOKEN",
          });
        } finally {
          envSnapshot.restore();
        }
      },
    );
  });

  it("keeps file unchanged when real-file dry-run fails and reports JSON error payload", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-int-fail-",
      '{ gateway: { port: 18789 }, secrets: { providers: { default: { source: "env" } } } }\n',
      async ({ configPath }) => {
        const envSnapshot = captureEnv(["MISSING_TEST_SECRET"]);
        try {
          deleteTestEnvValue("MISSING_TEST_SECRET");
          const output = createTestRuntime();
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
              runtime: output.runtime,
            }),
          ).rejects.toThrow("__exit__:1");

          expect(fs.readFileSync(configPath, "utf8")).toBe(before);
          expect(output.errors).toStrictEqual([]);
          const payload = JSON.parse(output.logs.join("\n")) as {
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
        }
      },
    );
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

  it.each([
    ["leaf", false],
    ["leaf", true],
    ["ancestor", false],
    ["ancestor", true],
  ] as const)(
    "validates only the final candidate after a %s overwrites an exec ref (dry run: %s)",
    async (replacement, dryRun) => {
      await withConfigFileHarness(
        "openclaw-config-cli-batch-overwrite-",
        "{ gateway: { port: 18789 } }\n",
        async ({ configPath, tempDir }) => {
          const provider = { source: "exec", command: path.join(tempDir, "missing-helper") };
          const secrets = { providers: { runner: provider, dormant: provider } };
          const raw = JSON.stringify({ gateway: { port: 18789 }, secrets });
          fs.writeFileSync(configPath, raw);
          const batch = [
            {
              path: "channels.discord.token",
              ref: { source: "exec", provider: "runner", id: "discarded" },
            },
            replacement === "leaf"
              ? { path: "channels.discord.token", value: "replacement-token" }
              : { path: "channels.discord", value: { token: "replacement-token" } },
          ];
          const output = createTestRuntime();

          await runConfigSet({
            cliOptions: { batchJson: JSON.stringify(batch), dryRun, json: dryRun },
            runtime: output.runtime,
          });

          expect(output.errors).toEqual([]);
          if (dryRun) {
            expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
              ok: true,
              refsChecked: 0,
              skippedExecRefs: 0,
            });
          } else {
            expect(JSON5.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
              channels: { discord: { token: "replacement-token" } },
              secrets,
            });
          }
        },
      );
    },
  );

  it.each([false, true])(
    "still rejects an unsafe exec ref assigned last in a batch (dry run: %s)",
    async (dryRun) => {
      await withConfigFileHarness(
        "openclaw-config-cli-batch-final-ref-",
        "{ gateway: { port: 18789 } }\n",
        async ({ configPath, tempDir }) => {
          const raw = JSON.stringify({
            secrets: {
              providers: {
                runner: { source: "exec", command: path.join(tempDir, "missing-helper") },
              },
            },
          });
          fs.writeFileSync(configPath, raw);
          const output = createTestRuntime();

          await expect(
            runConfigSet({
              cliOptions: {
                batchJson: JSON.stringify([
                  { path: "channels.discord.token", value: "superseded-token" },
                  {
                    path: "channels.discord.token",
                    ref: { source: "exec", provider: "runner", id: "retained" },
                  },
                ]),
                dryRun,
              },
              runtime: output.runtime,
            }),
          ).rejects.toThrow("__exit__:1");

          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(output.errors.join("\n")).toContain("secrets.providers.runner.command");
          expect(output.errors.join("\n")).toContain("is not readable");
        },
      );
    },
  );

  it("does not execute an overwritten exec ref during an --allow-exec batch dry-run", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-batch-superseded-exec-",
      "{ gateway: { port: 18789 } }\n",
      async ({ configPath, tempDir }) => {
        const markerPath = path.join(tempDir, "marker.txt");
        const batch = [
          ...createExecDryRunBatch({ markerPath }),
          { path: "channels.discord.token", value: "replacement-token" },
        ];
        const raw = fs.readFileSync(configPath, "utf8");
        const output = createTestRuntime();

        await runConfigSet({
          cliOptions: {
            batchJson: JSON.stringify(batch),
            dryRun: true,
            allowExec: true,
            json: true,
          },
          runtime: output.runtime,
        });

        expect(fs.existsSync(markerPath)).toBe(false);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(output.errors).toEqual([]);
        expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
          ok: true,
          refsChecked: 0,
          skippedExecRefs: 0,
        });
      },
    );
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
