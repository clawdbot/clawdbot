import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canSkipPristineStartupStateMigrations,
  planPristineStartupConfigMigrations,
  planPristineStartupStateMigrations,
} from "./pristine-startup-state.js";

const roots: string[] = [];

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

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("pristine startup state", () => {
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

  it("retains migrations for bundled plugins with doctor state surfaces", () => {
    const env = addBundledPlugin(
      createFixture({ plugins: { entries: { example: { enabled: true } } } }),
      "example",
      { doctorContract: true },
    );

    expect(canSkipPristineStartupStateMigrations(env)).toBe(false);
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
