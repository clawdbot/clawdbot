// Real CLI processes must keep unrelated plugin runtimes cold on read-only command paths.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";

const execFileAsync = promisify(execFile);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cold-commands-"));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const cases = [
  { label: "hooks", args: ["hooks", "--json"], needsMemoryOwner: false },
  {
    label: "skills-info",
    args: ["skills", "info", "fixture-skill", "--json"],
    needsMemoryOwner: false,
  },
  {
    label: "memory-status",
    args: ["memory", "status", "--agent", "main", "--json"],
    needsMemoryOwner: true,
  },
] as const;

it.each(cases)(
  "keeps an unrelated plugin runtime cold for $label",
  async ({ args, label, needsMemoryOwner }) => {
    const root = path.join(tempRoot, label);
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const pluginDir = path.join(root, "cold-plugin");
    const memoryOwnerDir = path.join(root, "memory-owner");
    fs.mkdirSync(path.join(workspaceDir, "skills", "fixture-skill"), { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: Cold path fixture\n---\n",
    );
    const fixture = createColdPluginFixture({
      rootDir: pluginDir,
      pluginId: `cold-${label}`,
      runtimeMessage: `${label} imported an unrelated plugin runtime`,
      manifest: { providers: [], channels: [], providerAuthChoices: [], channelConfigs: {} },
    });
    if (needsMemoryOwner) {
      // Keep this fixture about the ownership boundary: the selected CLI owner must
      // execute while the unrelated sentinel stays cold. memory-core behavior has
      // its own focused CLI suite, including the stale-search result contract.
      fs.mkdirSync(memoryOwnerDir, { recursive: true });
      fs.writeFileSync(
        path.join(memoryOwnerDir, "package.json"),
        JSON.stringify({
          name: "@example/openclaw-memory-owner",
          version: "1.0.0",
          type: "commonjs",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(memoryOwnerDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "memory-owner",
          name: "Memory Owner",
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          commandAliases: [{ name: "fixture-memory", kind: "runtime-slash", cliCommand: "memory" }],
        }),
      );
      fs.writeFileSync(
        path.join(memoryOwnerDir, "index.cjs"),
        [
          'const fs = require("node:fs");',
          "module.exports = {",
          '  id: "memory-owner",',
          "  register(api) {",
          '    fs.writeFileSync(process.env.MEMORY_OWNER_MARKER, "loaded", "utf8");',
          "    api.registerCli(({ program }) => {",
          '      const memory = program.command("memory");',
          '      memory.command("status").option("--agent <id>").option("--json").action(() => console.log("[]"));',
          '    }, { descriptors: [{ name: "memory", description: "Memory fixture", hasSubcommands: true }] });',
          "  },",
          "};",
          "",
        ].join("\n"),
      );
    }
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          load: { paths: [pluginDir, ...(needsMemoryOwner ? [memoryOwnerDir] : [])] },
          entries: {
            [fixture.pluginId]: { enabled: true },
            ...(needsMemoryOwner ? { "memory-owner": { enabled: true } } : {}),
          },
        },
      }),
    );

    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", ...args],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          // This fixture owns command imports, not entrypoint respawn or compile-cache behavior.
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          VITEST: undefined,
          OPENCLAW_CONFIG_PATH: configPath,
          MEMORY_OWNER_MARKER: path.join(root, "memory-owner-loaded"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_DEV_SOURCE_ROOT: path.resolve("."),
          OPENCLAW_HOME: path.join(root, "home"),
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      `${label} imported an unrelated plugin runtime`,
    );
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    if (needsMemoryOwner) {
      expect(fs.existsSync(path.join(root, "memory-owner-loaded"))).toBe(true);
    }
  },
  150_000,
);
