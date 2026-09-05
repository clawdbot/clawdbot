import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { formatCliProcessFailure, runCliProcessChild } from "../cli-process-child.test-helpers.js";

it.each(["restart", "install", "missing candidate"] as const)(
  "handles %s after replacing the updater's module files",
  async (scenario) => {
    await withOpenClawTestState(
      { prefix: "openclaw-update-command-replacement-", scenario: "minimal", applyEnv: false },
      async (state) => {
        const script = String.raw`
          import assert from "node:assert/strict";
          import fs from "node:fs/promises";
          import { registerHooks } from "node:module";
          import path from "node:path";
          import { pathToFileURL } from "node:url";

          const scenario = ${JSON.stringify(scenario)};
          const root = ${JSON.stringify(state.path("installation"))};
          const dist = path.join(root, "dist");
          const receipt = path.join(root, "candidate.json");
          const owner = ${JSON.stringify(new URL("./update-command-service-command.ts", import.meta.url).href)};
          await fs.mkdir(dist, { recursive: true });

          // A split build can emit a separate namespace facade even when other
          // imports have already loaded the underlying implementation. Keep the
          // actual helpers cached, then replace only the owner's facade files.
          const facades = new Map();
          for (const specifier of [
            "./shared.js",
            "./update-command-service-recovery.js",
            "../daemon-cli/install.runtime.js",
            "../daemon-cli/install.js",
          ]) {
            const source = new URL(specifier.replace(/\.js$/, ".ts"), owner).href;
            await import(source);
            const facade = path.join(dist, "old-" + facades.size + ".mjs");
            await fs.writeFile(facade, "export * from " + JSON.stringify(source) + ";\n");
            facades.set(specifier, pathToFileURL(facade).href);
          }
          registerHooks({
            resolve(specifier, context, nextResolve) {
              const facade = context.parentURL === owner && facades.get(specifier);
              return facade ? { url: facade, shortCircuit: true } : nextResolve(specifier, context);
            },
          });
          const { runUpdatedInstallGatewayCommand } = await import(owner);

          await fs.rm(dist, { recursive: true });
          await fs.mkdir(dist);
          const params = {
            result: { root, mode: "npm" },
            opts: { json: true },
            invocationEnv: process.env,
            timeoutMs: 10_000,
          };
          if (scenario === "missing candidate") {
            await assert.rejects(runUpdatedInstallGatewayCommand(params, "install"), {
              message: "updated install entrypoint not found under " + root,
            });
          } else {
            await fs.writeFile(path.join(dist, "index.mjs"), [
              'import fs from "node:fs";',
              'fs.writeFileSync(' + JSON.stringify(receipt) + ', JSON.stringify({',
              '  args: process.argv.slice(2),',
              '  node: process.execPath,',
              '  config: process.env.OPENCLAW_CONFIG_PATH,',
              '  compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE,',
              '}));',
            ].join("\n"));
            assert.equal(await runUpdatedInstallGatewayCommand(params, scenario, true), true);
            const observed = JSON.parse(await fs.readFile(receipt, "utf8"));
            assert.deepEqual(observed, {
              args: ["gateway", scenario, scenario === "install" ? "--force" : "--preserve-definition", "--json"],
              node: process.execPath,
              config: process.env.OPENCLAW_CONFIG_PATH,
              compileCacheDisabled: "1",
            });
          }
          console.log("UPDATE_COMMAND_AFTER_REPLACEMENT_OK");
        `;
        const result = await runCliProcessChild({
          nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
          env: {
            PATH: process.env.PATH,
            ...state.envVars,
            TMPDIR: state.root,
            TMP: state.root,
            TEMP: state.root,
          },
        });
        const failure = formatCliProcessFailure({
          reason: "Update command child failed",
          ...result,
        });
        expect(result.signal, failure).toBeNull();
        expect(result.code, failure).toBe(0);
        expect(result.stdout, failure).toContain("UPDATE_COMMAND_AFTER_REPLACEMENT_OK");
      },
    );
  },
);
