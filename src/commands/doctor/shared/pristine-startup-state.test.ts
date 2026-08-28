import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  canSkipPristineStartupStateMigrations,
  planPristineStartupConfigMigrations,
  planPristineStartupStateMigrations,
} from "./pristine-startup-state.js";

const roots: string[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture(config: Record<string, unknown>, stateEntries: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pristine-startup-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  fs.mkdirSync(stateDir, { recursive: true });
  for (const entry of stateEntries) {
    fs.mkdirSync(path.join(stateDir, entry), { recursive: true });
  }
  return {
    HOME: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

function addBundledPlugin(
  env: ReturnType<typeof createFixture>,
  pluginId: string,
  options: { doctorContract?: boolean } = {},
) {
  const bundledPluginsDir = path.join(env.HOME, "bundled-plugins");
  const pluginDir = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId })}\n`,
  );
  if (options.doctorContract) {
    fs.writeFileSync(path.join(pluginDir, "doctor-contract-api.js"), "export {};\n");
  }
  return {
    ...env,
    VITEST: "true",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
}

function addConfiguredPlugin(
  env: ReturnType<typeof createFixture>,
  pluginId: string,
  options: {
    additionalLoadPaths?: readonly string[];
    doctorContract?: boolean;
    minHostVersion?: string;
  } = {},
) {
  const pluginsDir = path.join(env.HOME, "configured-plugins");
  const pluginDir = path.join(pluginsDir, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId, configSchema: { type: "object" } })}\n`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };\n`,
  );
  if (options.minHostVersion) {
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify({
        name: `fixture-${pluginId}`,
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.cjs"],
          install: { minHostVersion: options.minHostVersion },
        },
      })}\n`,
    );
  }
  if (options.doctorContract) {
    fs.writeFileSync(path.join(pluginDir, "doctor-contract-api.js"), "export {};\n");
  }

  const config = JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")) as {
    plugins?: Record<string, unknown>;
  };
  config.plugins = {
    ...config.plugins,
    allow: [pluginId],
    load: { paths: [pluginsDir, ...(options.additionalLoadPaths ?? [])] },
  };
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(config)}\n`);
  return env;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("pristine startup state", () => {
  it("accepts a missing explicitly selected profile root", () => {
    const root = tempDirs.make("openclaw-pristine-profile-");
    const stateDir = path.join(root, ".openclaw-typo");
    fs.mkdirSync(path.join(root, ".clawdbot"));

    expect(
      planPristineStartupStateMigrations({
        HOME: root,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toEqual({
      skipAllStateMigrations: true,
      skipCoreStateMigrations: true,
    });
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("accepts the core-only Gateway benchmark config", () => {
    const env = createFixture({
      browser: { enabled: false },
      gateway: { mode: "local" },
      plugins: { enabled: true, entries: { browser: { enabled: false } } },
    });

    expect(canSkipPristineStartupStateMigrations(env)).toBe(true);
  });

  it("rejects existing state and migration-bearing agent config", () => {
    expect(canSkipPristineStartupStateMigrations(createFixture({}, ["agents"]))).toBe(false);
    expect(
      canSkipPristineStartupStateMigrations(
        createFixture({
          memory: { search: { provider: "local" } },
          agents: { defaults: {} },
        }),
      ),
    ).toBe(false);
  });

  it("accepts normal agent/model config backed by a stateless bundled plugin", () => {
    const env = addBundledPlugin(
      createFixture({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6" },
            models: { "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } } },
            workspace: "/tmp/workspace",
          },
          list: [{ id: "main", workspace: "/tmp/workspace" }],
        },
        plugins: { enabled: true, allow: ["openai"], entries: { openai: { enabled: true } } },
        skills: { allowBundled: [] },
      }),
      "openai",
    );

    expect(canSkipPristineStartupStateMigrations(env)).toBe(true);
  });

  it("accepts canonical internal hook configuration", () => {
    const env = createFixture({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "session-memory": {
              enabled: true,
              env: { OPENCLAW_HOOK_TEST: "enabled" },
              customOption: "value",
            },
          },
        },
      },
    });

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: true,
      skipCoreStateMigrations: true,
    });
  });

  it("retains migrations for legacy, external, and malformed hook configuration", () => {
    const unsafeHooks = [
      { gmail: { account: "operator@example.com" } },
      { internal: { installs: { "session-memory": { source: "bundled" } } } },
      { internal: { handlers: [] } },
      { internal: { load: { extraDirs: ["/tmp/hooks"] } } },
      { internal: { enabled: "yes" } },
      { internal: { entries: [] } },
      { internal: { entries: { "session-memory": { enabled: "yes" } } } },
      { internal: { entries: { "session-memory": { env: { INVALID: true } } } } },
    ];

    for (const hooks of unsafeHooks) {
      expect(
        planPristineStartupStateMigrations(createFixture({ hooks })),
        JSON.stringify(hooks),
      ).toEqual({
        skipAllStateMigrations: false,
        skipCoreStateMigrations: false,
      });
    }
  });

  it("retains migrations for bundled plugins with doctor state surfaces", () => {
    const env = addBundledPlugin(
      createFixture({ plugins: { entries: { example: { enabled: true } } } }),
      "example",
      { doctorContract: true },
    );

    expect(canSkipPristineStartupStateMigrations(env)).toBe(false);
  });

  it("skips migration discovery for manifest-owned stateless configured plugin paths", () => {
    const env = addConfiguredPlugin(
      createFixture({ gateway: { mode: "local" }, plugins: { enabled: true } }),
      "stateless-plugin",
    );

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: true,
      skipCoreStateMigrations: true,
    });
  });

  it("retains migration discovery for configured plugin doctor contracts", () => {
    const env = addConfiguredPlugin(
      createFixture({ gateway: { mode: "local" }, plugins: { enabled: true } }),
      "stateful-plugin",
      { doctorContract: true },
    );

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });
  });

  it("retains bundled doctor migrations when a configured plugin is incompatible", () => {
    const fixture = addConfiguredPlugin(
      createFixture({ gateway: { mode: "local" }, plugins: { enabled: true } }),
      "future-plugin",
      { minHostVersion: ">=9999.0.0" },
    );
    const env = addBundledPlugin(fixture, "future-plugin", { doctorContract: true });

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });
  });

  it("retains migration discovery when another configured plugin path is missing", () => {
    const fixture = createFixture({ gateway: { mode: "local" }, plugins: { enabled: true } });
    const env = addConfiguredPlugin(fixture, "stateless-plugin", {
      additionalLoadPaths: [path.join(fixture.HOME, "missing-plugin")],
    });

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });
  });

  it("retains plugin migrations while skipping absent core state for load paths", () => {
    const env = createFixture({
      gateway: { mode: "local" },
      plugins: { allow: ["example"], load: { paths: ["/plugins/example"] } },
    });

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });
  });

  it("retains core migrations for config that can point outside the state root", () => {
    const env = createFixture({ session: { store: "/tmp/sessions.json" } });

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
  });

  it("revalidates guarded config without depending on post-guard state files", () => {
    const env = createFixture({});

    expect(
      planPristineStartupConfigMigrations(
        { gateway: { mode: "local" }, plugins: { load: { paths: ["/plugins/example"] } } },
        env,
      ),
    ).toEqual({ skipAllStateMigrations: false, skipCoreStateMigrations: true });
    expect(
      planPristineStartupConfigMigrations({ session: { store: "/tmp/sessions.json" } }, env),
    ).toEqual({ skipAllStateMigrations: false, skipCoreStateMigrations: false });
    expect(planPristineStartupConfigMigrations({ $include: "base.json" }, env)).toEqual({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
    expect(
      planPristineStartupConfigMigrations({ agents: { $include: "agents.json" } }, env),
    ).toEqual({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
  });

  it("rejects enabled plugin entries and includes", () => {
    expect(
      canSkipPristineStartupStateMigrations(
        createFixture({ plugins: { entries: { example: { enabled: true } } } }),
      ),
    ).toBe(false);
    expect(canSkipPristineStartupStateMigrations(createFixture({ $include: "base.json" }))).toBe(
      false,
    );
  });
});
