// Real CLI process coverage for pre-action legacy migration ownership.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture(label: string) {
  const root = tempDirs.make(`openclaw-preaction-owner-${label}-`);
  const stateDir = path.join(root, "state");
  const pluginDir = path.join(root, "memory-owner");
  const markerPath = path.join(root, "action.json");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(path.join(stateDir, "agent"), { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "agent", "auth.json"), "{}\n");
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@example/openclaw-memory-owner",
      version: "1.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "memory-owner",
      name: "Memory Owner",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      commandAliases: [{ name: "fixture-memory", kind: "runtime-slash", cliCommand: "memory" }],
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    [
      'const fs = require("node:fs");',
      "module.exports = {",
      '  id: "memory-owner",',
      "  register(api) {",
      "    api.registerCli(({ program }) => {",
      '      const memory = program.command("memory").option("--agent <id>");',
      "      memory",
      '        .command("status")',
      '        .option("--agent <id>")',
      '        .option("--index")',
      '        .option("--json")',
      "        .action((opts, command) => {",
      "          const agent = opts.agent ?? command.parent.opts().agent ?? null;",
      '          fs.writeFileSync(process.env.ACTION_MARKER, JSON.stringify({ agent }), "utf8");',
      '          if (agent && !["main", "work"].includes(agent)) {',
      '            console.error(`Unknown agent id "${agent}".`);',
      "            process.exitCode = 1;",
      "            return;",
      "          }",
      "          console.log(JSON.stringify({ agent }));",
      "        });",
      '    }, { descriptors: [{ name: "memory", description: "Memory fixture", hasSubcommands: true }] });',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: path.join(root, "workspace-main") },
          work: { workspace: path.join(root, "workspace-work") },
        },
      },
      plugins: {
        load: { paths: [pluginDir] },
        entries: { "memory-owner": { enabled: true } },
      },
    }),
  );
  return { configPath, markerPath, root, stateDir };
}

function runFixture(label: string, args: string[]) {
  const fixture = createFixture(label);
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/entry.ts", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      ACTION_MARKER: fixture.markerPath,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      VITEST: undefined,
      OPENCLAW_CONFIG_PATH: fixture.configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DEV_SOURCE_ROOT: path.resolve("."),
      OPENCLAW_HOME: path.join(fixture.root, "home"),
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: fixture.stateDir,
    },
    timeout: 60_000,
  });
  const action = fs.existsSync(fixture.markerPath)
    ? (JSON.parse(fs.readFileSync(fixture.markerPath, "utf8")) as { agent: string | null })
    : null;
  return { action, fixture, output: `${result.stdout}\n${result.stderr}`, result };
}

describe("CLI pre-action migration agent ownership", () => {
  it.each([
    {
      label: "leaf-option",
      args: ["memory", "status", "--index", "--agent", "main", "--json"],
      agent: "main",
    },
    {
      label: "parent-option",
      args: ["memory", "--agent", "main", "status", "--index", "--json"],
      agent: "main",
    },
    {
      label: "leaf-over-parent",
      args: ["memory", "--agent", "main", "status", "--index", "--agent", "work", "--json"],
      agent: "work",
    },
  ])("uses the explicit agent from $label before the leaf action", ({ agent, args, label }) => {
    const { action, fixture, output, result } = runFixture(label, args);

    expect(result.status, output).toBe(0);
    expect(action).toEqual({ agent });
    expect(output).not.toContain("Deferred legacy agent/session migration");
    expect(fs.existsSync(path.join(fixture.stateDir, "agent", "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.stateDir, "agents", agent, "agent", "auth.json"))).toBe(
      true,
    );
  });

  it("keeps an omitted owner safely deferred for an explicit multi-agent roster", () => {
    const { action, fixture, output, result } = runFixture("omitted", [
      "memory",
      "status",
      "--index",
      "--json",
    ]);

    expect(result.status, output).toBe(0);
    expect(action).toEqual({ agent: null });
    expect(output).toContain("Deferred legacy agent/session migration: select an agent owner");
    expect(fs.existsSync(path.join(fixture.stateDir, "agent", "auth.json"))).toBe(true);
  });

  it.each([
    { agent: "missing", label: "unknown", normalizedTarget: "missing" },
    { agent: "main!", label: "invalid", normalizedTarget: "main" },
  ])(
    "does not use an $label explicit agent as a migration owner",
    ({ agent, label, normalizedTarget }) => {
      const { action, fixture, output, result } = runFixture(label, [
        "memory",
        "status",
        "--index",
        "--agent",
        agent,
        "--json",
      ]);

      expect(result.status, output).toBe(1);
      expect(action).toEqual({ agent });
      expect(output).toContain(`Unknown agent id "${agent}".`);
      expect(output).toContain("Deferred legacy agent/session migration: select an agent owner");
      expect(fs.existsSync(path.join(fixture.stateDir, "agent", "auth.json"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.stateDir, "agents", normalizedTarget))).toBe(false);
    },
  );
});
