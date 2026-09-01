// Process regressions for pristine startup eligibility and deferred config observation.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import {
  createSourceRuntime,
  runIsolatedModuleScript,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("gateway startup-migration refusal", () => {
  it("skips state-only checkpoint work when config and state remain absent", async () => {
    const root = await fs.promises.realpath(tempDirs.make("openclaw-configless-checkpoint-"));
    const runtimeRoot = createSourceRuntime(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    const preflightUrl = pathToFileURL(
      path.join(runtimeRoot, "src", "commands", "doctor-config-preflight.ts"),
    ).href;
    const checkpointUrl = pathToFileURL(
      path.join(runtimeRoot, "src", "infra", "startup-migration-checkpoint.ts"),
    ).href;
    const script = `
      const steps = [];
      const { runDoctorConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
      const { hasActiveStartupMigrationLease } = await import(${JSON.stringify(checkpointUrl)});
      await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
        requireStateMigrationCheckpoint: true,
        measure: async (name, run) => {
          steps.push(name);
          return await run();
        },
      });
      console.log("__RESULT__" + JSON.stringify({
        activeLease: hasActiveStartupMigrationLease({ env: process.env }),
        stateMigrationsImported: steps.includes(
          "doctor.config-preflight.state-migrations-import",
        ),
      }));
    `;
    const run = () =>
      runIsolatedModuleScript(env, script, {
        runtimeRoot,
        timeoutMs: 60_000,
      });
    const readResult = (result: Awaited<ReturnType<typeof runIsolatedModuleScript>>) => {
      const resultLine = result.stdout.split("\n").find((line) => line.startsWith("__RESULT__"));
      expect(resultLine, `${result.stderr}\n${result.stdout}`).toBeDefined();
      return JSON.parse(resultLine!.slice("__RESULT__".length)) as {
        activeLease: boolean;
        stateMigrationsImported: boolean;
      };
    };

    const first = readResult(await run());
    const second = readResult(await run());

    // This direct preflight is state-only. Gateway refusal coverage remains in
    // doctor-config-preflight.process.test.ts and still requires the readiness checkpoint.
    expect(first).toEqual({ activeLease: false, stateMigrationsImported: false });
    expect(second).toEqual({ activeLease: false, stateMigrationsImported: false });
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  }, 150_000);
});

describe("CLI pristine startup after early config observation", () => {
  it.each([
    { name: "explicit Gateway target", explicit: true, existingState: false, stateful: false },
    { name: "configured Gateway target", explicit: false, existingState: false, stateful: false },
    { name: "existing shared state", explicit: true, existingState: true, stateful: false },
    { name: "stateful authored config", explicit: true, existingState: false, stateful: true },
  ])(
    "preserves the migration decision for $name",
    async ({ explicit, existingState, stateful }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-cli-pristine-observation-"));
      const runtimeRoot = createSourceRuntime(root);
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const timelinePath = path.join(root, "timeline.jsonl");
      const config = {
        gateway: { mode: "local", port: 19876, auth: { mode: "token", token: "test-token" } },
        agents: { defaults: { workspace: path.join(root, "workspace") } },
        logging: { file: path.join(root, "openclaw.log") },
        // Inherited plugin selectors must not add unrelated convergence work to this fixture.
        plugins: { enabled: false },
        ...(stateful ? { messages: { ackReaction: "ok" } } : {}),
      } satisfies OpenClawConfig;
      const configRaw = JSON.stringify(config);
      fs.writeFileSync(configPath, configRaw);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DIAGNOSTICS: "1",
        OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
        OPENCLAW_HIDE_BANNER: "1",
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_DATA_HOME: path.join(root, "xdg-data"),
        XDG_STATE_HOME: path.join(root, "xdg-state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        TMPDIR: root,
        NO_COLOR: "1",
      };
      delete env.NODE_ENV;
      delete env.VITEST;
      delete env.VITEST_POOL_ID;
      delete env.VITEST_WORKER_ID;
      delete env.OPENCLAW_PROFILE;
      delete env.OPENCLAW_CONTAINER;
      delete env.OPENCLAW_GATEWAY_URL;
      delete env.OPENCLAW_GATEWAY_TOKEN;
      delete env.OPENCLAW_GATEWAY_PASSWORD;
      // Check the authored input without warming the CLI child's startup graph.
      const { planPristineStartupConfigMigrations } =
        await import("./doctor/shared/pristine-startup-state.js");
      expect(planPristineStartupConfigMigrations(config, env)).toEqual({
        skipAllStateMigrations: !stateful,
        skipCoreStateMigrations: !stateful,
      });
      const sourceUrl = (relative: string) =>
        pathToFileURL(path.join(runtimeRoot, "src", relative)).href;
      const args = [
        "attach",
        "movies-a1166b81",
        ...(explicit ? ["--url", "ws://127.0.0.1:19877", "--token", "test-token"] : []),
      ];
      const rpcSource = `
      export * from ${JSON.stringify(sourceUrl("gateway/call.ts"))};
      export async function callGateway(options) {
        if (options.method !== "sessions.resolve") throw new Error("Unexpected RPC: " + options.method);
        globalThis[Symbol.for("openclaw.test.pristineStartupRpcCalls")].push({
          method: options.method, params: options.params, url: options.url ?? null,
          configMode: options.config?.gateway?.mode, configPort: options.config?.gateway?.port,
        });
        return { ok: false, candidates: [
          { key: "agent:main:task:a1166b81-1111-4111-8111-111111111111", displayName: "first" },
          { key: "agent:main:task:a1166b81-2222-4222-8222-222222222222", displayName: "second" },
        ] };
      }
    `;
      // Exercise the real early read, Commander preaction and Doctor decision. Only the
      // resolution RPC is synthetic; ambiguity stops before grants or an external client.
      const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { DatabaseSync } from "node:sqlite";
      import { registerHooks } from "node:module";
      const calls = globalThis[Symbol.for("openclaw.test.pristineStartupRpcCalls")] = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const parent = context.parentURL ?? "";
          if (specifier.endsWith("/gateway/call.js") &&
              (parent.endsWith("/cli/session-target.ts") || parent.endsWith("/cli/session-target.js"))) {
            return { shortCircuit: true,
              url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(rpcSource)}) };
          }
          return nextResolve(specifier, context);
        },
      });
      if (${existingState}) {
        const { openOpenClawStateDatabase, closeOpenClawStateDatabase } =
          await import(${JSON.stringify(sourceUrl("state/openclaw-state-db.ts"))});
        openOpenClawStateDatabase({ env: process.env });
        closeOpenClawStateDatabase();
      }
      const databasePath = path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
      const databaseExistedBefore = fs.existsSync(databasePath);
      const { runCli } = await import(${JSON.stringify(sourceUrl("cli/run-main.ts"))});
      process.argv = [process.execPath, "openclaw", ...${JSON.stringify(args)}];
      let message;
      try { await runCli(process.argv); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      const { flushDiagnosticsTimeline } =
        await import(${JSON.stringify(sourceUrl("infra/diagnostics-timeline.ts"))});
      flushDiagnosticsTimeline();
      const events = fs.readFileSync(process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH, "utf8")
        .trim().split("\\n").map(line => JSON.parse(line));
      const stages = events.filter(event => event.type === "span.end" &&
        event.name === "cli.command-startup").map(event => event.attributes?.stage);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      let health;
      try { health = database.prepare("SELECT last_known_good_json FROM config_health_entries WHERE config_path = ?")
        .get(process.env.OPENCLAW_CONFIG_PATH); }
      finally { database.close(); }
      process.stdout.write("__RESULT__" + JSON.stringify({
        message, calls, stages, databaseExistedBefore,
        observedConfigMode: health ? JSON.parse(health.last_known_good_json).gatewayMode : null,
      }) + "\\n");
    `;
      const result = await runIsolatedModuleScript(env, script, { runtimeRoot, timeoutMs: 60_000 });
      const output = `${result.stderr}\n${result.stdout}`;
      const resultLines = result.stdout.split("\n").filter((line) => line.startsWith("__RESULT__"));
      expect(resultLines, output).toHaveLength(1);
      const observed = JSON.parse(resultLines[0]!.slice("__RESULT__".length));
      expect(observed.message).toContain("Session reference is ambiguous:");
      expect(observed.message).toContain("first");
      expect(observed.message).toContain("second");
      expect(observed.calls).toEqual([
        {
          method: "sessions.resolve",
          params: { shortId: "a1166b81", slugHint: "movies" },
          url: explicit ? "ws://127.0.0.1:19877" : null,
          configMode: "local",
          configPort: 19876,
        },
      ]);
      expect(observed.databaseExistedBefore).toBe(existingState);
      expect(observed.observedConfigMode).toBe("local");
      expect(observed.stages).toContain("config-ready");
      expect(observed.stages).toContain("doctor.config-preflight.config-snapshot");
      expect(observed.stages.includes("doctor.config-preflight.state-migrations-import")).toBe(
        existingState || stateful,
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe(configRaw);
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    },
    75_000,
  );
});
