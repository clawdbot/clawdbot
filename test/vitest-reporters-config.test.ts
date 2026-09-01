import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";

const reporterConfigs = [
  "vitest.config.ts",
  "test/vitest/vitest.tooling.config.ts",
  "test/vitest/vitest.cli-process.config.ts",
  "test/vitest/vitest.ui.config.ts",
  "test/vitest/vitest.ui-e2e.config.ts",
  "test/vitest/vitest.e2e.config.ts",
  "ui/vitest.config.ts",
  "ui/vitest.node.config.ts",
];

type ReporterEntry = [string, Record<string, unknown>];
type ReporterResolution = {
  defaults: Array<{ config: string; reporters: ReporterEntry[]; cli: ReporterEntry[] }>;
  custom: ReporterEntry[];
  customCli: ReporterEntry[];
  injectedPty: ReporterEntry[];
};

describe("Vitest reporter contracts", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  it.each(["false", "true"])(
    "reports completed agent tests and preserves overrides with GITHUB_ACTIONS=%s",
    (githubActions) => {
      // Vite's bundled loader writes beside the config's nearest node_modules.
      // Own that lifetime instead of writing into the installed dependency tree.
      const configRoot = dirs.make("oc-reporter-config-");
      fs.mkdirSync(path.join(configRoot, "node_modules"));
      const configFiles = reporterConfigs.map((config, index) => {
        const file = path.join(configRoot, `${index}.mts`);
        fs.writeFileSync(
          file,
          `export { default } from ${JSON.stringify(path.resolve(config))};\n`,
        );
        return file;
      });
      // Resolve in a fresh process: shared config and std-env capture their environment on import.
      // This starts no test workers and leaves the enclosing Vitest module/cache ownership alone.
      const result = spawnNodeEvalSync(
        `
          import path from "node:path";
          import { parseCLI, resolveConfig } from "vitest/node";
          import { sharedVitestConfig } from "./test/vitest/vitest.shared.config.ts";
          import { createTuiPtyVitestConfig } from "./test/vitest/vitest.tui-pty.config.ts";
          const defaults = [];
          for (const [index, config] of ${JSON.stringify(reporterConfigs)}.entries()) {
            const root = config.startsWith("ui/") ? path.resolve("ui") : process.cwd();
            const options = { root, config: ${JSON.stringify(configFiles)}[index] };
            const normal = await resolveConfig(options);
            const cli = parseCLI(["vitest", "--reporter=json"]).options;
            const override = await resolveConfig({ ...cli, ...options });
            defaults.push({ config, reporters: normal.vitestConfig.reporters, cli: override.vitestConfig.reporters });
          }
          const customConfig = {
            ...sharedVitestConfig,
            test: {
              ...sharedVitestConfig.test,
              reporters: [["json", { outputFile: "custom-report.json" }]],
            },
          };
          const custom = await resolveConfig({ config: false }, customConfig);
          const customCli = await resolveConfig({
            ...parseCLI(["vitest", "--reporter=json", "--reporter=json"]).options,
            config: false,
          }, customConfig);
          const injectedPty = await resolveConfig({ config: false }, createTuiPtyVitestConfig({
            GITHUB_ACTIONS: process.env.GITHUB_ACTIONS === "true" ? "false" : "true",
          }));
          console.log("REPORTER_RESOLUTION " + JSON.stringify({
            defaults,
            custom: custom.vitestConfig.reporters,
            customCli: customCli.vitestConfig.reporters,
            injectedPty: injectedPty.vitestConfig.reporters,
          }));
        `,
        {
          imports: ["tsx"],
          env: { ...process.env, AI_AGENT: "vitest-reporter-test", GITHUB_ACTIONS: githubActions },
          timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      const report = result.stdout
        .split("\n")
        .find((line) => line.startsWith("REPORTER_RESOLUTION "));
      expect(report, result.stdout).toBeDefined();
      const resolved = JSON.parse(
        report!.slice("REPORTER_RESOLUTION ".length),
      ) as ReporterResolution;
      const expected = githubActions === "true" ? ["verbose", "github-actions"] : ["verbose"];
      for (const { config, reporters, cli } of resolved.defaults) {
        expect(
          reporters.map(([name]) => name),
          config,
        ).toEqual(
          config === "test/vitest/vitest.ui-e2e.config.ts" ? [...expected, "default"] : expected,
        );
        expect(cli, `${config} CLI override`).toEqual([["json", {}]]);
      }
      expect(resolved.defaults).toHaveLength(reporterConfigs.length);
      expect(resolved.custom).toEqual([["json", { outputFile: "custom-report.json" }]]);
      expect(resolved.customCli).toEqual(resolved.custom);
      expect(resolved.injectedPty.map(([name]) => name)).toEqual(
        githubActions === "true" ? ["verbose"] : ["verbose", "github-actions"],
      );
    },
  );
});
