import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
  runIsolatedModuleScript,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const doctorArgs = ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"];
let runtimeRoot: string;

beforeAll(() => {
  runtimeRoot = createBuiltRuntime(fs.realpathSync(tempDirs.make("doctor-plugin-config-runtime-")));
});

function createDoctorFixture() {
  const root = fs.realpathSync(tempDirs.make("doctor-plugin-config-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NO_COLOR: "1",
  };
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { mode: "local", auth: { mode: "none" } },
      plugins: { enabled: false },
    }),
  );
  const bootstrap = runBuiltRuntime(runtimeRoot, env, doctorArgs, 60_000);
  expect(bootstrap.status, `${bootstrap.stdout}\n${bootstrap.stderr}`).toBe(0);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenClawConfig;
  return { root, stateDir, configPath, env, config };
}

describe("Doctor retired plugin install config", () => {
  it.each(["empty", "populated", "included", "empty-included"] as const)(
    "removes %s legacy records after preserving the canonical install index",
    async (kind) => {
      const { root, stateDir, configPath, env, config } = createDoctorFixture();
      const empty = kind === "empty" || kind === "empty-included";
      const included = kind === "included" || kind === "empty-included";
      const durable = { source: "path" as const, installPath: path.join(root, "current-plugin") };
      await writePersistedInstalledPluginIndexInstallRecords(
        { existing: durable },
        { stateDir, env, config },
      );
      const legacy = { source: "path" as const, installPath: path.join(root, "missing-plugin") };
      config.plugins = {
        ...(kind === "empty-included" ? {} : config.plugins),
        installs: empty ? {} : { existing: legacy, imported: legacy },
      };
      if (included) {
        fs.writeFileSync(path.join(stateDir, "plugins.json"), JSON.stringify(config.plugins));
      }
      fs.writeFileSync(
        configPath,
        JSON.stringify(included ? { ...config, plugins: { $include: "./plugins.json" } } : config),
      );
      // A promoted backup would restore an older file and hide the missing migration.
      expect(fs.existsSync(`${configPath}.last-good`)).toBe(false);

      for (const pass of ["repair", "repeat"]) {
        const result = runBuiltRuntime(runtimeRoot, env, doctorArgs, 60_000);
        const output = `${pass}: ${result.stdout}\n${result.stderr}`;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(0);
        const repaired = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenClawConfig;
        expect(repaired.plugins, output).not.toHaveProperty("installs");
        if (included) {
          expect(repaired.plugins).toEqual({ $include: "./plugins.json" });
          expect(JSON.parse(fs.readFileSync(path.join(stateDir, "plugins.json"), "utf8"))).toEqual(
            kind === "empty-included" ? {} : { enabled: false },
          );
        }
        expect(await readPersistedInstalledPluginIndexInstallRecords({ stateDir, env })).toEqual(
          empty ? { existing: durable } : { existing: durable, imported: legacy },
        );
        const validation = runBuiltRuntime(runtimeRoot, env, ["config", "validate"], 30_000);
        expect(validation.status, `${validation.stdout}\n${validation.stderr}`).toBe(0);
      }
    },
    120_000,
  );

  it("preserves records when plain Doctor gains config-write consent after preflight", async () => {
    const { root, stateDir, configPath, env, config } = createDoctorFixture();
    const legacy = { source: "path" as const, installPath: path.join(root, "missing-plugin") };
    const candidate = { ...config, plugins: { ...config.plugins, installs: { imported: legacy } } };
    fs.writeFileSync(configPath, JSON.stringify({ ...candidate, unknownKey: true }));
    const writerUrl = new URL(
      "../flows/doctor-health-contribution-runners.config.ts",
      import.meta.url,
    );
    const configFlowUrl = new URL("./doctor-config-flow.ts", import.meta.url).href;
    const result = await runIsolatedModuleScript(
      env,
      `
      const { runWriteConfigHealth } = await import(${JSON.stringify(writerUrl.href)});
      const { loadAndMaybeMigrateDoctorConfig } = await import(${JSON.stringify(configFlowUrl)});
      const runtime = { log() {}, error() {}, exit(code) { throw new Error(String(code)); } };
      const configResult = await loadAndMaybeMigrateDoctorConfig({
        options: {}, confirm: async () => true, runtime,
      });
      const cfg = configResult.cfg;
      await runWriteConfigHealth({
        runtime,
        options: {},
        prompter: { shouldRepair: false },
        configResult,
        cfg,
        cfgForPersistence: { ...cfg, unknownKey: true },
        sourceConfigValid: false,
        configPath: ${JSON.stringify(configPath)},
        invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
        runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
      });
    `,
      { timeoutMs: 60_000 },
    );
    const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(repaired.plugins, result.stderr).not.toHaveProperty("installs");
    expect(repaired).not.toHaveProperty("unknownKey");
    expect(await readPersistedInstalledPluginIndexInstallRecords({ stateDir, env })).toEqual({
      imported: legacy,
    });
  }, 90_000);

  it("leaves malformed source records untouched before other config repairs", () => {
    const { configPath, env, config } = createDoctorFixture();
    const raw = JSON.stringify({
      ...config,
      unknownKey: true,
      plugins: { ...config.plugins, installs: { broken: { source: "invalid" } } },
    });
    fs.writeFileSync(configPath, raw);
    const result = runBuiltRuntime(runtimeRoot, env, doctorArgs, 60_000);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "plugins.installs contains invalid records",
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  }, 90_000);

  it("does not replay source records after later registry cleanup", async () => {
    const { root, stateDir, configPath, env, config } = createDoctorFixture();
    const legacy = { source: "path", installPath: path.join(root, "missing-plugin") };
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...config, plugins: { ...config.plugins, installs: { retired: legacy } } }),
    );
    const configFlowUrl = new URL("./doctor-config-flow.ts", import.meta.url).href;
    const writerUrl = new URL(
      "../flows/doctor-health-contribution-runners.config.ts",
      import.meta.url,
    ).href;
    const recordsUrl = new URL("../plugins/installed-plugin-index-records.ts", import.meta.url)
      .href;
    const result = await runIsolatedModuleScript(
      env,
      `
      import fs from "node:fs";
      const { loadAndMaybeMigrateDoctorConfig } = await import(${JSON.stringify(configFlowUrl)});
      const { runInitialConfigWriteHealth, runWriteConfigHealth } = await import(${JSON.stringify(writerUrl)});
      const { writePersistedInstalledPluginIndexInstallRecords } = await import(${JSON.stringify(recordsUrl)});
      const runtime = { log() {}, error() {}, exit(code) { throw new Error(String(code)); } };
      const options = { repair: true, nonInteractive: true, workspaceSuggestions: false };
      const configResult = await loadAndMaybeMigrateDoctorConfig({
        options, confirm: async () => true, runtime,
      });
      const ctx = {
        runtime, options, configResult, cfg: configResult.cfg,
        cfgForPersistence: structuredClone(configResult.cfg),
        sourceConfigValid: false, configPath: ${JSON.stringify(configPath)},
        prompter: { shouldRepair: true },
        invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
        runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
      };
      await writePersistedInstalledPluginIndexInstallRecords({}, { config: ctx.cfg });
      await runInitialConfigWriteHealth(ctx);
      fs.copyFileSync(ctx.configPath, ${JSON.stringify(path.join(root, "first-write.json"))});
      ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, bind: "loopback" } };
      await runWriteConfigHealth(ctx);
    `,
      { timeoutMs: 60_000 },
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "first-write.json"), "utf8")).plugins,
      result.stderr,
    ).not.toHaveProperty("installs");
    expect(await readPersistedInstalledPluginIndexInstallRecords({ stateDir, env })).toEqual({});
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).plugins).not.toHaveProperty("installs");
  }, 90_000);

  it("preserves enabled custom-path plugin settings before stale-config repair", async () => {
    const { root, stateDir, configPath, env, config } = createDoctorFixture();
    const pluginDir = path.join(root, "custom-plugin");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "migration-proof-plugin",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "migration-proof-plugin",
        configSchema: {
          type: "object",
          properties: { sentinel: { type: "string" } },
          additionalProperties: false,
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      'export default { id: "migration-proof-plugin", register() {} };\n',
    );
    const legacy = { source: "path" as const, sourcePath: pluginDir, installPath: pluginDir };
    const entry = { enabled: true, config: { sentinel: "preserved" } };
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        plugins: {
          enabled: true,
          entries: { "migration-proof-plugin": entry },
          installs: { "migration-proof-plugin": legacy },
        },
      }),
    );
    const result = runBuiltRuntime(runtimeRoot, env, doctorArgs, 60_000);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    const repaired = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenClawConfig;
    expect(repaired.plugins, output).not.toHaveProperty("installs");
    expect(repaired.plugins?.entries?.["migration-proof-plugin"], output).toEqual(entry);
    expect(
      (await readPersistedInstalledPluginIndexInstallRecords({ stateDir, env }))?.[
        "migration-proof-plugin"
      ],
    ).toEqual(legacy);
  }, 90_000);
});
