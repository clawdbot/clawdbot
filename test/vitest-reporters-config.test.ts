import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
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
  it.each(["false", "true"])(
    "reports completed agent tests and preserves overrides with GITHUB_ACTIONS=%s",
    (githubActions) => {
      // Resolve imported configs in a fresh process: shared config and std-env
      // capture their environment on import. Native resolution needs no proxy
      // config files or repeated bundling of the same dependency graph.
      const result = spawnNodeEvalSync(
        `
          import path from "node:path";
          import { pathToFileURL } from "node:url";
          import { parseCLI, resolveConfig } from "vitest/node";
          import { sharedVitestConfig } from "./test/vitest/vitest.shared.config.ts";
          import { createTuiPtyVitestConfig } from "./test/vitest/vitest.tui-pty.config.ts";
          const defaults = [];
          for (const config of ${JSON.stringify(reporterConfigs)}) {
            const root = config.startsWith("ui/") ? path.resolve("ui") : process.cwd();
            const imported = (await import(pathToFileURL(path.resolve(config)).href)).default;
            const options = { root, config: false };
            const normal = await resolveConfig(options, imported);
            const cli = parseCLI(["vitest", "--reporter=json"]).options;
            const override = await resolveConfig({ ...cli, ...options }, imported);
            defaults.push({ config, reporters: normal.test.reporters, cli: override.test.reporters });
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
            custom: custom.test.reporters,
            customCli: customCli.test.reporters,
            injectedPty: injectedPty.test.reporters,
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
          ["test/vitest/vitest.ui-e2e.config.ts", "test/vitest/vitest.e2e.config.ts"].includes(
            config,
          )
            ? [...expected, "default"]
            : expected,
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
