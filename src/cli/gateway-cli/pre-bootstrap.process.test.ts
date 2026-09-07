import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createSourceRuntime,
  runIsolatedModuleScript,
} from "../../commands/doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

function stateManifest(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filename = path.join(entry.parentPath, entry.name);
        return [
          path.relative(root, filename),
          createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        ];
      }),
  );
}

describe("Gateway config selection before migration admission", () => {
  it.each([false, true])(
    "preserves every state artifact with backup=%s",
    async (withBackup) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-readonly-bootstrap-"));
      const runtimeRoot = createSourceRuntime(root);
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
      );
      if (withBackup) {
        fs.writeFileSync(
          `${configPath}.bak`,
          JSON.stringify({
            gateway: { mode: "local" },
            agents: { defaults: { workspace: path.join(root, "workspace") } },
            messages: { ackReaction: "synthetic long-lived config baseline" },
            plugins: { enabled: false },
          }),
        );
      }
      const before = stateManifest(stateDir);
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
        OPENCLAW_TEST_FAST: "1",
      };
      const result = await runIsolatedModuleScript(
        env,
        `
      const { selectGatewayRunEnvironment, prepareGatewayRunBootstrap } = await import("./src/cli/gateway-cli/pre-bootstrap.ts");
      const runtime = { log() {}, error() {}, exit(code) { throw new Error("unexpected exit " + code); } };
      if (!await selectGatewayRunEnvironment({ opts: {}, runtime })) throw new Error("selection refused");
      if (!await prepareGatewayRunBootstrap({ opts: {}, runtime })) throw new Error("preparation refused");
      console.log("prepared");
    `,
        { runtimeRoot, timeoutMs: 60_000 },
      );
      expect(result.stdout).toContain("prepared");
      expect(stateManifest(stateDir)).toEqual(before);
    },
    90_000,
  );

  it.each([
    {
      flag: "--allow-unconfigured",
      dispatch: "fast",
      suffix: [],
      dev: false,
      allowUnconfigured: true,
    },
    {
      flag: "--allow-unconfigured",
      dispatch: "Commander",
      suffix: ["--"],
      dev: false,
      allowUnconfigured: true,
    },
    { flag: "--dev", dispatch: "fast", suffix: [], dev: true, allowUnconfigured: false },
    { flag: "--dev", dispatch: "Commander", suffix: ["--"], dev: true, allowUnconfigured: false },
  ])(
    "passes $flag through $dispatch startup admission without config",
    async ({ flag, suffix, dev, allowUnconfigured }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-startup-allowance-"));
      const runtimeRoot = createSourceRuntime(root);
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
        OPENCLAW_HIDE_BANNER: "1",
        OPENCLAW_GATEWAY_TOKEN: "synthetic-startup-allowance-token",
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_DATA_HOME: path.join(root, "xdg-data"),
        XDG_STATE_HOME: path.join(root, "xdg-state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
        TMPDIR: root,
        NO_COLOR: "1",
      };
      // Keep parsing, environment selection, preaction, and config admission real.
      // Replace only the final Gateway action; the built rig proves listener startup.
      const result = await runIsolatedModuleScript(
        env,
        `
      import { registerHooks } from "node:module";
      const calls = globalThis[Symbol.for("openclaw.test.startupAllowanceCalls")] = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const parent = context.parentURL ?? "";
          if (specifier === "./run.js" &&
              (parent.endsWith("/cli/gateway-cli/run-command.ts") || parent.endsWith("/cli/gateway-cli/run-command.js"))) {
            return {
              shortCircuit: true,
              url: "data:text/javascript," + encodeURIComponent(
                'export async function runGatewayCommand(opts) {' +
                'globalThis[Symbol.for("openclaw.test.startupAllowanceCalls")].push({' +
                'dev: opts.dev === true, allowUnconfigured: opts.allowUnconfigured === true }); }'
              ),
            };
          }
          return nextResolve(specifier, context);
        },
      });
      const { runCli } = await import("./src/cli/run-main.ts");
      process.argv = [process.execPath, "openclaw", "gateway", "run", "--port", "18736", ${JSON.stringify(flag)}, ...${JSON.stringify(suffix)}];
      await runCli(process.argv);
      process.stdout.write("__RESULT__" + JSON.stringify(calls) + "\\n");
    `,
        { runtimeRoot, timeoutMs: 60_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const results = result.stdout.split("\n").filter((line) => line.startsWith("__RESULT__"));
      expect(results, output).toHaveLength(1);
      expect(JSON.parse(results[0]!.slice("__RESULT__".length))).toEqual([
        { dev, allowUnconfigured },
      ]);
    },
    75_000,
  );
});
