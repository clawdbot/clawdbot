import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const target = "test/scripts/empty-policy.synthetic.test.ts";
const sibling = "test/scripts/empty-policy-sibling.synthetic.test.ts";
const source = "test/scripts/empty-policy.synthetic.ts";
const isolated = "test/scripts/control-ui-i18n.test.ts";
const config = "test/vitest/vitest.tooling.config.ts";

describe("project runner native empty-file policy", () => {
  it.for([
    { name: "delegated default", code: 1 },
    { name: "package test entry default", code: 1, entry: "projects" },
    {
      name: "projects compound help executes",
      code: 0,
      entry: "projects",
      excluded: false,
      tests: 1,
      flags: ["--help", "--no-help"],
    },
    {
      name: "projects compound help validates",
      code: 1,
      entry: "projects",
      flags: ["--help", "--no-help", "--passWithNoTests", "--passWithNoTests"],
      invalid: true,
    },
    {
      name: "projects compound help metadata",
      code: 0,
      entry: "projects",
      flags: ["--no-help", "--help", "--unknown-router-option"],
      help: true,
    },
    { name: "several exact files", code: 1, selectors: [target, sibling] },
    {
      name: "exact files across lanes",
      code: 1,
      selectors: [target, isolated],
      parallel: true,
      emptyInvocations: 2,
    },
    { name: "explicit true", code: 0, flags: ["--passWithNoTests=true"] },
    { name: "bare opt-in", code: 0, flags: ["--passWithNoTests"] },
    {
      name: "separated exclusion matching routed target",
      code: 0,
      excluded: false,
      flags: ["--exclude", target, "--passWithNoTests"],
    },
    { name: "explicit false", code: 1, flags: ["--passWithNoTests=false"] },
    { name: "native negation", code: 1, flags: ["--no-passWithNoTests"] },
    { name: "native dashed spelling", code: 0, flags: ["--pass-with-no-tests=true"] },
    {
      name: "invalid duplicate scalar",
      code: 1,
      flags: ["--passWithNoTests", "--passWithNoTests"],
      invalid: true,
    },
    { name: "direct configured default", code: 1, flags: ["--config", config] },
    { name: "cfg long control", code: 0, excluded: false, tests: 1, flags: ["--config", config] },
    { name: "cfg short control", code: 0, excluded: false, tests: 1, flags: ["-c", config] },
    { name: "cfg inline short", code: 0, excluded: false, tests: 1, flags: [`-c=${config}`] },
    { name: "cfg inline strict", code: 1, flags: [`-c=${config}`, "--passWithNoTests"] },
    ...[
      "--passWithNoTests=false",
      "--passWithNoTests=true",
      "--passWithNoTests",
      "--pass-with-no-tests=true",
    ].map((flag) => ({
      name: `direct configured strict ${flag}`,
      code: 1,
      flags: ["--config", config, flag],
    })),
    { name: "delegated separated false", code: 1, flags: ["--passWithNoTests", "false"] },
    { name: "delegated separated true", code: 0, flags: ["--passWithNoTests", "true"] },
    {
      name: "direct invalid scalar is not repaired",
      code: 1,
      flags: ["--config", config, "--no-passWithNoTests", "--passWithNoTests=true"],
      invalid: true,
    },
    {
      name: "direct help with strict scalar",
      code: 0,
      flags: ["--config", config, "--passWithNoTests=false", "--help=true"],
      help: true,
    },
    {
      name: "disabled help executes",
      code: 0,
      excluded: false,
      tests: 1,
      flags: ["--help", "false"],
    },
    {
      name: "named run version executes",
      code: 0,
      excluded: false,
      tests: 1,
      flags: ["--version"],
    },
    { name: "directory selection", code: 0, selectors: ["test/scripts"] },
    { name: "glob selection", code: 0, selectors: ["test/scripts/*.test.ts"] },
    { name: "mixed basename and exact selection", code: 0, selectors: ["empty-policy", target] },
    {
      name: "config selection",
      code: 0,
      selectors: ["test/vitest/vitest.tooling-docker.config.ts"],
      entry: "projects",
    },
    { name: "source-derived selection", code: 0, selectors: [source] },
    { name: "native help", code: 0, flags: ["--help=true"], help: true },
    { name: "non-excluded control", code: 0, excluded: false, tests: 1 },
    { name: "one surviving named file", code: 0, selectors: [target, sibling], tests: 1 },
    {
      name: "skipped case is still a discovered file",
      code: 0,
      excluded: false,
      tests: 1,
      skipped: true,
    },
  ])("$name", { timeout: 60_000 }, async (scenario, { signal, onTestFinished }) => {
    const lifetime = createFixtureLifetime();
    onTestFinished(() => lifetime.cleanup());
    await lifetime.run(async () => {
      // An unjoined child still owns its files: keep them outside the enclosing
      // Vitest process's disposable namespace, just like withShimFixture.
      const parent = process.platform === "win32" ? tmpdir() : path.dirname(tmpdir());
      const root = fs.realpathSync(lifetime.createTempDir("oc-default-empty-", parent));
      const stdout = createBoundedChildOutput();
      const stderr = createBoundedChildOutput();
      // Copy the real configs so their repoRoot is isolated; link their unchanged
      // setup, runner and source dependencies from the source checkout.
      fs.mkdirSync(path.join(root, "test/scripts"), { recursive: true });
      for (const name of ["vitest", "tsconfig"]) {
        fs.cpSync(path.join(repoRoot, "test", name), path.join(root, "test", name), {
          recursive: true,
        });
      }
      for (const name of ["scripts", "src", "packages", "node_modules"]) {
        fs.symlinkSync(path.join(repoRoot, name), path.join(root, name), "junction");
      }
      for (const name of ["package.json", "tsconfig.json"]) {
        fs.copyFileSync(path.join(repoRoot, name), path.join(root, name));
      }
      for (const entry of fs.readdirSync(path.join(repoRoot, "test"), { withFileTypes: true })) {
        if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
          fs.symlinkSync(
            path.join(repoRoot, "test", entry.name),
            path.join(root, "test", entry.name),
            "file",
          );
        }
      }
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json"),
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
        TSX_DISABLE_CACHE: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        COREPACK_ENABLE_NETWORK: "0",
        GIT_OPTIONAL_LOCKS: "0",
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        OPENCLAW_TEST_PROJECTS_TIMINGS: "0",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "module-cache"),
        OPENCLAW_VITEST_NO_OUTPUT_RETRY: "0",
        ...(scenario.parallel ? { OPENCLAW_TEST_PROJECTS_PARALLEL: "2" } : {}),
      };
      for (const name of ["home", "state", "tmp", "cache", "config"]) {
        fs.mkdirSync(path.join(root, name));
      }
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, "{}");
      const runFixtureCommand = (bin: string, commandArgs: string[]) =>
        lifetime.track(
          runManagedCommand({
            bin,
            args: commandArgs,
            cwd: root,
            env,
            signal,
            stdio: ["ignore", "pipe", "pipe"],
            timeoutMs: 45_000,
            timeoutKillGraceMs: 10_000,
            requireProcessTreeExit: process.platform !== "win32",
            onReady(child) {
              child.stdout?.on("data", stdout.append);
              child.stderr?.on("data", stderr.append);
            },
          }),
        );
      // Discovery must not inherit an enclosing checkout's ignored temp directory.
      expect(await runFixtureCommand("git", ["init", "--quiet"]), stderr.text()).toBe(0);
      const marker = path.join(root, "executed");
      fs.writeFileSync(path.join(root, source), "export const value = 1;\n");
      for (const file of [target, sibling, ...(scenario.parallel ? [isolated] : [])]) {
        fs.writeFileSync(
          path.join(root, file),
          `import fs from "node:fs";
import { it } from "vitest";
import "./empty-policy.synthetic.ts";
it${scenario.skipped ? ".skip" : ""}("records execution", () => fs.appendFileSync(${JSON.stringify(marker)}, "executed\\n"));
`,
        );
      }
      const output = path.join(root, "native.json");
      const args = [
        ...(scenario.entry === "projects"
          ? ["--import", "tsx", path.join(repoRoot, "scripts/test-projects.mts")]
          : [path.join(repoRoot, "scripts/run-vitest.mjs")]),
        ...(scenario.selectors ?? [target]),
        ...(scenario.emptyInvocations
          ? ["--reporter=verbose"]
          : ["--reporter=json", `--outputFile=${output}`]),
        "--exclude=src/scripts/**",
        ...(scenario.excluded === false
          ? []
          : [
              `--exclude=${target}`,
              ...(scenario.tests ? [] : [`--exclude=${sibling}`]),
              ...(scenario.parallel ? [`--exclude=${isolated}`] : []),
            ]),
        ...(scenario.flags ?? []),
      ];
      const code = await runFixtureCommand(process.execPath, args);
      const report = fs.existsSync(output)
        ? (JSON.parse(fs.readFileSync(output, "utf8")) as JsonTestResults)
        : undefined;
      const evidence = JSON.stringify({
        args,
        code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        report,
      });
      expect(code, evidence).toBe(scenario.code);
      expect(stderr.text(), evidence).not.toContain("Unhandled Errors");
      if (scenario.emptyInvocations) {
        expect(
          stderr.text().match(/No test files found, exiting with code 1/gu),
          evidence,
        ).toHaveLength(scenario.emptyInvocations);
      } else if (scenario.help) {
        expect(stdout.text().match(/Usage:/gu), evidence).toHaveLength(1);
        expect(stdout.text(), evidence).toMatch(/^vitest\//mu);
        expect(report).toBeUndefined();
      } else if (scenario.invalid) {
        expect(stderr.text()).toContain("Expected a single value for option");
        expect(report).toBeUndefined();
      } else {
        expect(report, evidence).toMatchObject({
          success: scenario.code === 0,
          numTotalTests: scenario.tests ?? 0,
        });
        expect(report?.testResults).toHaveLength(scenario.tests ? 1 : 0);
      }
      expect(fs.existsSync(marker), evidence).toBe(Boolean(scenario.tests && !scenario.skipped));
    });
  });
});
