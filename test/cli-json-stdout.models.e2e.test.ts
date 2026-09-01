import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readConfigMachineState } from "../src/state/config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

async function seedPendingStateMigration(stateDir: string) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(OPENCLAW_STATE_SCHEMA_SQL);
    database.exec("PRAGMA user_version = 0;");
  } finally {
    database.close();
  }
}

describe("cli json stdout contract", () => {
  it.each([
    { name: "leaf JSON", args: ["models", "refresh", "--json"] },
    { name: "parent JSON", args: ["models", "--json", "refresh"] },
    { name: "human output", args: ["models", "refresh"], human: true },
    {
      name: "forced Commander JSON",
      args: ["models", "refresh", "--json"],
      commander: true,
    },
    {
      name: "dual-TTY JSON",
      args: ["models", "refresh", "--json"],
      tty: true,
    },
  ])("renders model catalog refresh failures canonically for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
            "globalThis.fetch.mock = {};",
            ...("tty" in testCase
              ? [
                  'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
                  'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
                ]
              : []),
          ].join("\n"),
        ).toString("base64");
        const result = runBuiltCli(tempHome, testCase.args, {
          NODE_OPTIONS: `--import=data:text/javascript;base64,${preload}`,
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
          ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
        });
        const message = "Remote catalog refresh failed: Error: offline fixture";

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
          });
        }
        expect(result.stderr).toContain(message);
        expect(result.stderr.split(message)).toHaveLength(2);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-models-refresh-json-failure-e2e-" },
    );
  });

  // Every case opens the state database: config-health observation
  // (observeConfigSnapshot -> readConfigHealthStateFromStore) runs on any
  // config read whose file exists, so the migration diagnostic always lands
  // on stderr; the protected contract is that stdout stays exact.
  it.each([
    {
      name: "aliases list",
      args: ["models", "aliases", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "chat anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "fallbacks list",
      args: ["models", "fallbacks", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "image fallbacks list",
      args: ["models", "image-fallbacks", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "list control",
      args: ["models", "list", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "status control",
      args: ["models", "status", "--plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
    {
      name: "parent status control",
      args: ["models", "--status-plain"],
      opensStateDatabase: true,
      expectedStdout: "anthropic/claude-sonnet-4-6\n",
    },
  ])("keeps $name stdout exact during a pending state migration", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "isolated-state");
        const configPath = path.join(tempHome, "openclaw.json");
        const migrationDiagnostic = "state database schema migration pending";
        await seedPendingStateMigration(stateDir);
        await fs.writeFile(
          configPath,
          JSON.stringify({
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-sonnet-4-6",
                  fallbacks: ["anthropic/claude-sonnet-4-6"],
                },
                imageModel: { fallbacks: ["anthropic/claude-sonnet-4-6"] },
                models: { "anthropic/claude-sonnet-4-6": { alias: "chat" } },
              },
            },
          }),
        );

        const result = runBuiltCli(
          tempHome,
          testCase.args,
          {
            CI: "1",
            NO_COLOR: "1",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
          },
          { inheritEnvironment: false },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(testCase.expectedStdout);
        expect(result.stdout).not.toContain(migrationDiagnostic);
        expect(result.stderr.includes(migrationDiagnostic), result.stderr).toBe(
          testCase.opensStateDatabase,
        );
      },
      { prefix: "openclaw-models-plain-stdout-e2e-" },
    );
  });

  it.each(["--plain", "--json"])(
    "keeps human auth-list output on stdout when provider value is %s",
    async (provider) => {
      await withTempHome(
        async (tempHome) => {
          const result = runBuiltCli(tempHome, ["models", "auth", "list", "--provider", provider], {
            CI: "1",
            NO_COLOR: "1",
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          });

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Agent: main\n");
          expect(result.stdout).toContain(`Provider: ${provider}\n`);
          expect(result.stdout).toContain("Profiles: (none)\n");
          expect(result.stderr).not.toContain("Agent: main");
          expect(result.stderr).not.toContain(`Provider: ${provider}`);
        },
        { prefix: "openclaw-models-output-option-value-e2e-" },
      );
    },
  );

  it("preserves model catalog refresh success payloads and persisted rows", async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "isolated-state");
        const configPath = path.join(tempHome, "openclaw.json");
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        const generatedAt = Date.now() + 60_000;
        const bundle = {
          schemaVersion: 1,
          generatedAt,
          sourceCommit: "autoqa-model-catalog-fixture",
          providers: { openai: { models: [{ id: "gpt-5.6-luna" }] } },
        };
        const updatedBundle = { ...bundle, generatedAt: generatedAt + 1_000 };
        const preloadFor = (response: "initial" | "updated" | "unchanged" | "failure") => {
          const fixture = response === "initial" ? bundle : updatedBundle;
          const fetchResponse =
            response === "failure"
              ? 'throw new Error("offline fixture");'
              : response === "unchanged"
                ? "return new Response(null, { status: 304 });"
                : `return new Response(JSON.stringify(${JSON.stringify(fixture)}), { headers: { etag: '\"fixture\"' } });`;
          return Buffer.from(
            [
              'import net from "node:net";',
              'import module from "node:module";',
              'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
              "const createRequire = module.createRequire;",
              'module.createRequire = (...args) => new Proxy(createRequire(...args), { apply(target, receiver, request) { return String(request[0]).endsWith("/build-info.json") ? { builtAt: "2020-01-01T00:00:00.000Z" } : Reflect.apply(target, receiver, request); } });',
              "module.syncBuiltinESMExports();",
              `globalThis.fetch = async () => { ${fetchResponse} };`,
              "globalThis.fetch.mock = {};",
            ].join("\n"),
          ).toString("base64");
        };
        const runRefresh = (
          args: string[],
          response: "initial" | "updated" | "unchanged" | "failure",
        ) =>
          runBuiltCli(tempHome, ["models", ...args], {
            NODE_OPTIONS: `--import=data:text/javascript;base64,${preloadFor(response)}`,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
          });
        const readCatalogRow = () =>
          readConfigMachineState<{ generated_at: number; bundle_json: string }>(
            "modelCatalog.remote",
            { path: databasePath },
          );

        const human = runRefresh(["refresh"], "initial");
        expect(human.status, human.stderr).toBe(0);
        expect(human.stdout).toContain("Remote catalog refresh: updated (1 providers, 1 models;");
        expect(human.stdout).toContain(
          "A running Gateway applies the updated catalog after its next restart.",
        );

        const updated = runRefresh(["refresh", "--json"], "updated");
        expect(updated.status, updated.stderr).toBe(0);
        expect(JSON.parse(updated.stdout)).toEqual({
          status: "updated",
          generatedAt: updatedBundle.generatedAt,
          providers: 1,
          models: 1,
        });

        const unchanged = runRefresh(["--json", "refresh"], "unchanged");
        expect(unchanged.status, unchanged.stderr).toBe(0);
        expect(JSON.parse(unchanged.stdout)).toEqual({
          status: "unchanged",
          generatedAt: updatedBundle.generatedAt,
          providers: 1,
          models: 1,
        });
        const persistedRow = readCatalogRow();
        expect(persistedRow).toMatchObject({
          generated_at: updatedBundle.generatedAt,
          bundle_json: JSON.stringify(updatedBundle),
        });

        const failure = runRefresh(["refresh", "--json"], "failure");
        expect(failure.status, failure.stderr).toBe(1);
        expect(JSON.parse(failure.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Remote catalog refresh failed: Error: offline fixture",
          },
        });
        expect(readCatalogRow()).toEqual(persistedRow);

        await fs.writeFile(
          configPath,
          `${JSON.stringify({ models: { catalogRefresh: { enabled: false } } })}\n`,
          "utf8",
        );
        const disabled = runRefresh(["refresh", "--json"], "failure");
        expect(disabled.status, disabled.stderr).toBe(0);
        expect(JSON.parse(disabled.stdout)).toEqual({
          status: "disabled",
          providers: 0,
          models: 0,
        });
        expect(readCatalogRow()).toEqual(persistedRow);
      },
      { prefix: "openclaw-models-refresh-persistence-e2e-" },
    );
  });
});
