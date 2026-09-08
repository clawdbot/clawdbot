import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  loadPluginCliRegistrationEntriesWithDefaults,
} from "./cli-registry-loader.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["retained-agent", "install-roots", "install-state"] as const)(
  "fences hidden %s changes with unchanged serialized config and env",
  async (kind) => {
    const root = fs.realpathSync(makePluginLoaderTempDir());
    for (const id of ["alpha", "beta"]) {
      writePlugin({
        id,
        dir: path.join(root, id, ".openclaw", "extensions", id),
        filename: "index.cjs",
        body: `module.exports = { id: ${JSON.stringify(id)}, register(api) { api.registerCli(({ program }) => program.command(${JSON.stringify(id)}), { descriptors: [{ name: ${JSON.stringify(id)}, description: "Scope", hasSubcommands: false }] }); } };`,
      });
    }
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          alpha: { workspace: path.join(root, "alpha") },
          beta: { workspace: path.join(root, "beta") },
        },
      },
      plugins: { allow: ["alpha", "beta"] },
    };
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    if (kind === "install-state") {
      for (const id of ["alpha", "beta"]) {
        const installPath = path.join(root, id, ".openclaw", "extensions", id);
        writePersistedInstalledPluginIndexInstallRecordsSync(
          { [id]: { source: "path", installPath, sourcePath: installPath } },
          { config: cfg, env, stateDir: path.join(root, id, "state") },
        );
      }
    }
    const serialized = JSON.stringify([cfg, env]);
    const session = createPluginCliLoadSession();
    let previous: Awaited<ReturnType<typeof loadPluginCliRegistrationEntriesWithDefaults>> = [];
    for (const id of ["alpha", "beta"]) {
      const run = async () => {
        if (previous.length) {
          await expect(previous[0]!.register(new Command())).rejects.toThrow(
            /preparation inputs changed/,
          );
        }
        expect(
          (await loadPluginCliDescriptors({ cfg, env, session })).map(({ name }) => name),
        ).toEqual([id]);
        previous = await loadPluginCliRegistrationEntriesWithDefaults({ cfg, env, session });
        const loaderOptions: import("./cli-registry-loader.js").PluginCliLoaderOptions = {
          pluginSdkResolution: "src",
        };
        const captured = await loadPluginCliRegistrationEntriesWithDefaults({
          cfg,
          env,
          session,
          loaderOptions,
        });
        loaderOptions.pluginSdkResolution = "dist";
        await expect(captured[0]!.register(new Command())).rejects.toThrow(
          /preparation inputs changed/,
        );
        previous = await loadPluginCliRegistrationEntriesWithDefaults({ cfg, env, session });
        const program = new Command();
        await previous[0]!.register(program);
        expect(program.commands.map((command) => command.name())).toEqual([id]);
        expect(JSON.stringify([cfg, env])).toBe(serialized);
      };
      if (kind === "retained-agent") {
        retainLegacyDefaultAgentId(cfg, id);
        await run();
      } else {
        await withPluginInstallRoots(
          {
            extensionsDir: path.join(
              root,
              kind === "install-state" ? "shared" : id,
              ".openclaw",
              "extensions",
            ),
            gitDir: path.join(root, "shared", "git"),
            npmDir: path.join(root, "shared", "npm"),
            stateDir: path.join(root, id, "state"),
          },
          run,
        );
      }
    }
    session.close();
    await expect(previous[0]!.register(new Command())).rejects.toThrow(/preparation is closed/);
    expect(() => session.resolve({ cfg, env })).toThrow(/preparation is closed/);
  },
);

it("retains the exact new config object when a fresh read has identical serialized values", () => {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const cfg = { plugins: { enabled: false } };
  const fresh = { ...cfg };
  const session = createPluginCliLoadSession();
  const previous = session.resolve({ cfg, env });
  const next = session.resolve({ cfg: fresh, env });
  expect(next.context.rawConfig).toBe(fresh);
  expect(next.context.activationSourceConfig).toBe(fresh);
  expect(() => previous.assertCurrent()).toThrow(/preparation inputs changed/);
  const freshEnv = { ...env };
  const changedEnv = session.resolve({ cfg: fresh, env: freshEnv });
  expect(changedEnv).not.toBe(next);
  expect(() => next.assertCurrent()).toThrow(/preparation inputs changed/);
  session.close();
});
