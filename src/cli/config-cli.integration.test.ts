// Config CLI integration tests cover end-to-end config command reads and writes.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

// Register the harness metadata mock before loading the real config and command modules.
const configRuntime = await import("../config/config.js");
const { clearConfigCache } = configRuntime;
const { REDACTED_SENTINEL } = await import("../config/redact-snapshot.js");
const runtimeSchema = await import("../config/runtime-schema.js");
const { runConfigGet, runConfigSet, runConfigUnset } = await import("./config-cli.js");
const { withConfigFileHarness } = useConfigCliIntegrationHarness();

function installRuntimeSchemaReadHook(hook: () => void | Promise<void>): void {
  const readSchema = runtimeSchema.readBestEffortRuntimeConfigSchema;
  vi.spyOn(runtimeSchema, "readBestEffortRuntimeConfigSchema").mockImplementation(async () => {
    const result = await readSchema();
    await hook();
    return result;
  });
}

describe("config cli integration", () => {
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
    await withConfigFileHarness(
      "openclaw-config-cli-plugin-hooks-",
      "{ gateway: { port: 18789 } }\n",
      async ({ configPath }) => {
        const output = createTestRuntime();
        await runConfigSet({
          path: "plugins.entries.openclaw-mem0.hooks.allowConversationAccess",
          value: "true",
          cliOptions: {},
          runtime: output.runtime,
        });

        expect(output.errors).toStrictEqual([]);
        const afterWrite = JSON5.parse(fs.readFileSync(configPath, "utf8"));
        expect(afterWrite.plugins?.entries?.["openclaw-mem0"]?.hooks).toEqual({
          allowConversationAccess: true,
        });
      },
    );
  });
});
