// Vitest unit-fast config tests validate fast unit test project setup.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { cliProcessTestFiles } from "./vitest/vitest.cli-process-paths.mjs";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createContractsPluginVitestConfig } from "./vitest/vitest.contracts-plugin.config.ts";
import { pluginContractPatterns } from "./vitest/vitest.contracts-shared.ts";
import { createPluginSdkLightVitestConfig } from "./vitest/vitest.plugin-sdk-light.config.ts";
import { createUnitFastFakeTimersVitestConfig } from "./vitest/vitest.unit-fast-fake-timers.config.ts";
import { createUnitFastIsolatedVitestConfig } from "./vitest/vitest.unit-fast-isolated.config.ts";
import {
  classifyUnitFastTestFileContent,
  collectBroadUnitFastTestCandidates,
  collectUnitFastTestCandidates,
  collectUnitFastTestFileAnalysis,
  forcedUnitFastTestFiles,
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTestFilesForIncludePatterns,
  getUnitFastTimerTestFiles,
  isUnitFastTestFile,
  isUnitFastIsolatedTestFile,
  isUnitFastTimerTestFile,
  resolveUnitFastTestIncludePattern,
  resolveUnitFastIsolatedTestIncludePattern,
  resolveUnitFastTimerTestIncludePattern,
} from "./vitest/vitest.unit-fast-paths.mjs";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

const ENV_ISOLATION_SETUP_PATH = /[\\/]test[\\/]setup\.env\.ts$/u;

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected unit-fast vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

type UnitFastAnalysisEntry = ReturnType<typeof collectUnitFastTestFileAnalysis>[number];

function collectUnroutedForcedFiles(
  analysis: readonly UnitFastAnalysisEntry[],
  forcedFiles: ReadonlySet<string>,
): Array<{ file: string; forced: boolean; unitFast: boolean }> {
  const unrouted: Array<{ file: string; forced: boolean; unitFast: boolean }> = [];
  for (const entry of analysis) {
    if (!forcedFiles.has(entry.file)) {
      continue;
    }
    if (!entry.forced || !entry.unitFast) {
      unrouted.push({ file: entry.file, forced: entry.forced, unitFast: entry.unitFast });
    }
  }
  return unrouted;
}

describe("unit-fast vitest lane", () => {
  let configProbeResult: ReturnType<typeof spawnNodeEvalSync>;
  let unitFastConfig: ReturnType<typeof createUnitFastVitestConfig>;
  let unitFastTestFiles: ReturnType<typeof getUnitFastTestFiles>;
  let unitFastIsolatedTestFiles: ReturnType<typeof getUnitFastIsolatedTestFiles>;
  let unitFastTimerTestFiles: ReturnType<typeof getUnitFastTimerTestFiles>;
  let unitFastAnalysis: ReturnType<typeof collectUnitFastTestFileAnalysis>;
  let broadCandidates: ReturnType<typeof collectBroadUnitFastTestCandidates>;
  let broadAnalysis: ReturnType<typeof collectUnitFastTestFileAnalysis>;
  let currentCandidates: ReturnType<typeof collectUnitFastTestCandidates>;

  beforeAll(() => {
    const script = `
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      let gitLsFilesCalls = 0;
      const originalSpawnSync = childProcess.spawnSync;
      childProcess.spawnSync = function patchedSpawnSync(...args) {
        const [command, commandArgs] = args;
        if (command === "git" && commandArgs?.[0] === "ls-files") {
          gitLsFilesCalls += 1;
          const stdout = [
            "src/agents/agent-tools.deferred-followup-guidance.test.ts",
            "src/hooks/frontmatter.test.ts",
          ].join("\\0") + "\\0";
          return {
            pid: 0,
            output: [null, stdout, ""],
            stdout,
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        return originalSpawnSync.apply(this, args);
      };
      syncBuiltinESMExports();
      let readdirSyncCalls = 0;
      let hookFileReads = 0;
      let outsideFileReads = 0;
      const originalReaddirSync = fs.readdirSync;
      const originalReadFileSync = fs.readFileSync;
      fs.readdirSync = function patchedReaddirSync(...args) {
        readdirSyncCalls += 1;
        return originalReaddirSync.apply(this, args);
      };
      fs.readFileSync = function patchedReadFileSync(...args) {
        const file = String(args[0]).replaceAll("\\\\", "/");
        if (file.endsWith("/src/hooks/frontmatter.test.ts")) {
          hookFileReads += 1;
        } else if (file.endsWith("/src/agents/agent-tools.deferred-followup-guidance.test.ts")) {
          outsideFileReads += 1;
        }
        return originalReadFileSync.apply(this, args);
      };
      await import("./test/vitest/vitest.hooks.config.ts?scope-probe=" + Date.now());
      const scopedHookFileReads = hookFileReads;
      const scopedOutsideFileReads = outsideFileReads;
      await import("./test/vitest/vitest.unit-fast.config.ts?io-probe=" + Date.now());
      console.log(
        "UNIT_FAST_IO_PROBE",
        gitLsFilesCalls,
        readdirSyncCalls,
        scopedHookFileReads,
        scopedOutsideFileReads,
      );
    `;
    configProbeResult = spawnNodeEvalSync(script, {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        OPENCLAW_VITEST_INCLUDE_FILE: undefined,
      },
      evalFlag: "-e",
      imports: ["tsx"],
    });
    unitFastConfig = createUnitFastVitestConfig({});
    unitFastTestFiles = getUnitFastTestFiles();
    unitFastIsolatedTestFiles = getUnitFastIsolatedTestFiles();
    unitFastTimerTestFiles = getUnitFastTimerTestFiles();
    unitFastAnalysis = collectUnitFastTestFileAnalysis();
    currentCandidates = collectUnitFastTestCandidates();
    broadCandidates = collectBroadUnitFastTestCandidates();
    broadAnalysis = collectUnitFastTestFileAnalysis(process.cwd(), { scope: "broad" });
  });

  it("loads the config without recursively walking repo roots", () => {
    expect(configProbeResult.status, configProbeResult.stderr).toBe(0);
    const probeMatch = configProbeResult.stdout.match(
      /UNIT_FAST_IO_PROBE (\d+) (\d+) (\d+) (\d+)/u,
    );
    expect(probeMatch, configProbeResult.stdout).not.toBeNull();
    expect(Number(probeMatch?.[1])).toBe(1);
    expect(Number(probeMatch?.[2])).toBeLessThan(20);
    expect(Number(probeMatch?.[3])).toBe(1);
    expect(Number(probeMatch?.[4])).toBe(0);
  });

  it("keeps untracked tests in their planned fast lane and execution include list", () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-untracked-")));
    const pure = "src/hooks/pure.test.ts";
    const stateful = "src/hooks/stateful.test.ts";
    const quoted = "src/hooks/quoted-é.test.ts";
    const ignored = "src/hooks/ignored.test.ts";
    const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
    try {
      fs.mkdirSync(path.join(cwd, "src/hooks"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".gitignore"), `${ignored}\n`);
      for (const file of [pure, quoted, ignored]) {
        fs.writeFileSync(
          path.join(cwd, file),
          'import { it } from "vitest"; it("pure", () => {});',
        );
      }
      fs.writeFileSync(
        path.join(cwd, stateful),
        'import { it } from "vitest"; import { check } from "./stateful.test-support.js"; it("helper", check);',
      );
      fs.writeFileSync(
        path.join(cwd, "src/hooks/stateful.test-support.ts"),
        'import { vi } from "vitest"; export const check = vi.fn();',
      );
      expect(spawnSync("git", ["init"], { cwd }).status).toBe(0);
      expect(
        spawnSync("git", ["ls-files", "--error-unmatch", "--", pure, stateful], { cwd }).status,
      ).toBe(1);
      // Fresh process: discovery snapshots must be taken after the fixture exists.
      const result = spawnNodeEvalSync(
        `
        process.chdir(${JSON.stringify(cwd)});
        const paths = await import(${moduleUrl("test/vitest/vitest.unit-fast-paths.mjs")});
        const { createVitestRunSpecs, writeVitestIncludeFile } = await import(${moduleUrl("scripts/test-projects.test-support.mts")});
        const { createUnitFastVitestConfig } = await import(${moduleUrl("test/vitest/vitest.unit-fast.config.ts")});
        const { createUnitFastIsolatedVitestConfig } = await import(${moduleUrl("test/vitest/vitest.unit-fast-isolated.config.ts")});
        const { createScopedVitestConfig } = await import(${moduleUrl("test/vitest/vitest.scoped-config.ts")});
        const fs = await import("node:fs");
        const specs = createVitestRunSpecs(${JSON.stringify([pure, stateful])}, { baseEnv: {} });
        const factories = {
          "test/vitest/vitest.unit-fast.config.ts": createUnitFastVitestConfig,
          "test/vitest/vitest.unit-fast-isolated.config.ts": createUnitFastIsolatedVitestConfig,
        };
        try {
          const runs = specs.map((spec) => {
            writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns);
            return { config: spec.config, include: factories[spec.config](spec.env).test.include };
          });
          console.log(JSON.stringify({
            inventory: paths.getUnitFastTestFiles(),
            isolated: paths.getUnitFastIsolatedTestFiles(),
            runs,
            excluded: createScopedVitestConfig(["src/hooks/**/*.test.ts"], { env: {} }).test.exclude
              .filter((file) => file.startsWith("src/hooks/")),
            ignored: paths.resolveUnitFastTestIncludePattern(${JSON.stringify(ignored)}),
          }));
        } finally {
          for (const spec of specs) fs.rmSync(spec.includeFilePath, { force: true });
        }
      `,
        { imports: ["tsx"] },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        inventory: [pure, quoted, stateful],
        isolated: [stateful],
        runs: [
          { config: "test/vitest/vitest.unit-fast.config.ts", include: [pure] },
          { config: "test/vitest/vitest.unit-fast-isolated.config.ts", include: [stateful] },
        ],
        excluded: [pure, quoted, stateful],
        ignored: null,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("runs cache-friendly tests without the reset-heavy runner or runtime setup", () => {
    const testConfig = requireTestConfig(unitFastConfig);

    expect(testConfig.isolate).toBe(false);
    expect(testConfig.runner).toBeUndefined();
    // Env isolation only: the fast shards install the isolated test home but
    // must not pull in the shared setup's module mocks.
    expect(testConfig.setupFiles).toStrictEqual([expect.stringMatching(ENV_ISOLATION_SETUP_PATH)]);
    expect(testConfig.include).toContain(
      "src/agents/agent-tools.deferred-followup-guidance.test.ts",
    );
    expect(testConfig.include).toContain("src/acp/runtime/registry.test.ts");
    expect(testConfig.include).toContain("src/commands/status-overview-values.test.ts");
    expect(testConfig.include).toContain("src/plugins/config-policy.test.ts");
    expect(testConfig.include).toContain("src/sessions/session-lifecycle-events.test.ts");
    expect(testConfig.include).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(testConfig.include).not.toEqual(expect.arrayContaining(unitFastIsolatedTestFiles));
  });

  it("does not treat moved config paths as CLI include filters", () => {
    const config = createUnitFastVitestConfig(
      {},
      {
        argv: ["node", "vitest", "run", "--config", "test/vitest/vitest.unit-fast.config.ts"],
      },
    );

    const testConfig = requireTestConfig(config);
    expect(testConfig.include).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(testConfig.include).toContain("src/commands/status-overview-values.test.ts");
  });

  it("keeps excluded stateful files out of directory-scoped CLI runs", () => {
    // A directory argument must narrow the curated inventory, never replace it with the
    // directory glob. The lane is non-isolated, so re-admitting an excluded stateful file
    // pollutes whichever unrelated files share its worker.
    const otherLaneFiles = new Set([
      ...getUnitFastTimerTestFiles(),
      ...getUnitFastIsolatedTestFiles(),
    ]);
    for (const dir of ["src/plugins", "src/agents", "src/commands"]) {
      const testConfig = requireTestConfig(
        createUnitFastVitestConfig({}, { argv: ["node", "vitest", "run", dir] }),
      );
      const include = testConfig.include as string[];
      const expected = unitFastTestFiles.filter(
        (file) => file.startsWith(`${dir}/`) && !otherLaneFiles.has(file),
      );

      expect(include, dir).toEqual(expected);
      expect(
        include.filter((entry) => !isUnitFastTestFile(entry)),
        `${dir} admitted non-unit-fast entries`,
      ).toEqual([]);
    }

    const pluginsInclude = requireTestConfig(
      createUnitFastVitestConfig({}, { argv: ["node", "vitest", "run", "src/plugins"] }),
    ).include as string[];
    expect(isUnitFastTestFile("src/plugins/install-persistence.test.ts")).toBe(false);
    expect(pluginsInclude).not.toContain("src/plugins/install-persistence.test.ts");

    // Glob-scoped lanes keep their own scope too: a parent-directory argument must not widen
    // contracts-plugin from `contracts/` to every sibling test under `src/plugins`.
    const contractsInclude = requireTestConfig(
      createContractsPluginVitestConfig({}, ["node", "vitest", "run", "src/plugins"]),
    ).include as string[];
    expect(contractsInclude).toEqual(pluginContractPatterns);
  });

  it("keeps obvious stateful files out of the unit-fast lane", () => {
    for (const file of [
      "src/agents/agent-command.compaction-rotation.test.ts",
      "src/agents/agent-command.embedded-maintenance.test.ts",
    ]) {
      expect(isUnitFastTestFile(file), file).toBe(false);
      expect(resolveUnitFastTestIncludePattern(file), file).toBeNull();
      expect(resolveUnitFastIsolatedTestIncludePattern(file), file).toBeNull();
    }
    expect(isUnitFastTestFile("src/plugin-sdk/temp-path.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/agents/openai-transport-stream.base.test.ts")).toBe(false);
    expect(
      isUnitFastTestFile("src/agents/embedded-agent-runner/run.shared-integration.test.ts"),
    ).toBe(false);
    expect(isUnitFastTestFile("src/auto-reply/reply/dispatch-from-config.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/agents/sandbox.resolveSandboxContext.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/acp/runtime/session-meta.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/system-agent/assistant.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/flows/channel-setup.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/flows/doctor-health-contributions.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/plugins/install.npm-spec.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/secrets/runtime.test.ts")).toBe(false);
    expect(resolveUnitFastTestIncludePattern("src/plugin-sdk/temp-path.ts")).toBeNull();
    expect(classifyUnitFastTestFileContent("vi.resetModules(); await import('./x.js')")).toEqual([
      "module-mocking",
      "vitest-mock-api",
      "dynamic-import",
    ]);
  });

  it("keeps process-launching CLI files in their owner lane", () => {
    for (const file of cliProcessTestFiles) {
      expect(isUnitFastTestFile(file), file).toBe(false);
      expect(unitFastTestFiles, file).not.toContain(file);
    }
  });

  it("routes unit-fast source files to their unit-fast sibling tests", () => {
    expect(resolveUnitFastTestIncludePattern("src/plugin-sdk/provider-entry.ts")).toBe(
      "src/plugin-sdk/provider-entry.test.ts",
    );
    expect(resolveUnitFastTestIncludePattern("src/commands/status-overview-values.ts")).toBe(
      "src/commands/status-overview-values.test.ts",
    );
  });

  it("routes audited stateful-looking tests through the isolated fast lane", () => {
    const forcedFileSet = new Set(forcedUnitFastTestFiles);
    const forcedAnalysisCount = countMatching(unitFastAnalysis, (entry) =>
      forcedFileSet.has(entry.file),
    );

    expect(forcedAnalysisCount).toBe(forcedUnitFastTestFiles.length);
    for (const file of forcedUnitFastTestFiles) {
      expect(unitFastTestFiles).toContain(file);
      expect(isUnitFastTestFile(file)).toBe(true);
      if (unitFastTimerTestFiles.includes(file)) {
        expect(unitFastIsolatedTestFiles).not.toContain(file);
      } else {
        expect(unitFastIsolatedTestFiles).toContain(file);
        expect(isUnitFastIsolatedTestFile(file)).toBe(true);
        expect(resolveUnitFastTestIncludePattern(file)).toBeNull();
        expect(resolveUnitFastIsolatedTestIncludePattern(file)).toBe(file);
      }
    }
    const unroutedForcedFiles = collectUnroutedForcedFiles(unitFastAnalysis, forcedFileSet);
    expect(unroutedForcedFiles).toStrictEqual([]);

    const isolatedConfig = requireTestConfig(createUnitFastIsolatedVitestConfig({}));
    expect(isolatedConfig.isolate).toBe(true);
    expect(isolatedConfig.runner).toBeUndefined();
    expect(isolatedConfig.include).toEqual(unitFastIsolatedTestFiles);
    expect(isolatedConfig.setupFiles).toStrictEqual([
      expect.stringMatching(ENV_ISOLATION_SETUP_PATH),
    ]);
  });

  it("isolates tests that import stateful test helpers", () => {
    // Fixture files must genuinely import a stateful test helper; #121923
    // rewrote the outbound poll tests to be stateless, so they left this list.
    const files = [
      "src/acp/translator.error-kind.test.ts",
      "src/agents/auth-profiles/oauth-refresh-error.test.ts",
      "src/agents/embedded-agent-runner/model.provider-hooks.timeout.test.ts",
      "src/agents/prepared-model-runtime.scoped-refresh.test.ts",
      "src/agents/tools/computer-tool.context.test.ts",
      "src/agents/tools/computer-tool.schema.test.ts",
      "src/agents/tools/computer-tool.v2.test.ts",
      "src/auto-reply/reply/agent-runner-execution-runtime.test.ts",
    ];
    for (const file of files) {
      const analysis = unitFastAnalysis.find((entry) => entry.file === file);
      expect(analysis?.reasons).toContain("stateful-test-helper");
      expect(unitFastIsolatedTestFiles).toContain(file);
      expect(resolveUnitFastTestIncludePattern(file)).toBeNull();
      expect(resolveUnitFastIsolatedTestIncludePattern(file)).toBe(file);
    }
  });

  it("routes fake-timer unit-fast tests through the serial fake-timer lane", () => {
    const fakeTimerFiles = unitFastAnalysis
      .filter((entry) => entry.unitFast && entry.reasons.includes("fake-timers"))
      .map((entry) => entry.file);
    expect(unitFastTimerTestFiles.length).toBeGreaterThan(0);
    expect(unitFastTimerTestFiles).toEqual(fakeTimerFiles);
    for (const file of unitFastTimerTestFiles) {
      expect(isUnitFastTimerTestFile(file)).toBe(true);
      expect(resolveUnitFastTestIncludePattern(file)).toBeNull();
      expect(resolveUnitFastTimerTestIncludePattern(file)).toBe(file);
    }

    const fastConfig = requireTestConfig(unitFastConfig);
    const isolatedConfig = requireTestConfig(createUnitFastIsolatedVitestConfig({}));
    const timerConfig = requireTestConfig(createUnitFastFakeTimersVitestConfig({}));
    expect(fastConfig.include).not.toEqual(expect.arrayContaining(unitFastTimerTestFiles));
    expect(isolatedConfig.include).not.toEqual(expect.arrayContaining(unitFastTimerTestFiles));
    expect(timerConfig.include).toEqual(unitFastTimerTestFiles);
    expect(timerConfig.fileParallelism).toBe(false);
    expect(timerConfig.maxWorkers).toBe(1);
    expect(timerConfig.setupFiles).toStrictEqual([expect.stringMatching(ENV_ISOLATION_SETUP_PATH)]);
  });

  it("keeps broad audit candidates separate from automatically routed unit-fast tests", () => {
    expect(currentCandidates.length).toBeGreaterThanOrEqual(unitFastTestFiles.length);
    expect(broadCandidates.length).toBeGreaterThan(currentCandidates.length);
    expect(countMatching(broadAnalysis, (entry) => entry.unitFast)).toBeGreaterThan(
      unitFastTestFiles.length,
    );
  });

  it("keeps scoped unit-fast exclusions equivalent to the full inventory", () => {
    const cases = [
      { dir: "src/hooks", patterns: ["src/hooks/**/*.test.ts"] },
      { dir: "src", patterns: ["src/agents/*/**/*.test.ts"] },
      { dir: "src/acp", patterns: ["src/acp/client.test.ts"] },
      { dir: "extensions", patterns: ["extensions/**/*.test.ts"] },
      { dir: undefined, patterns: ["test/**/*.test.ts"] },
      { dir: undefined, patterns: ["src/{hooks,infra}/**/*.test.ts"] },
      { dir: "src", patterns: [] },
    ];

    for (const { dir, patterns } of cases) {
      const prefix = dir ? `${dir}/` : "";
      const expected = unitFastTestFiles.filter((file) => {
        if (prefix && !file.startsWith(prefix)) {
          return false;
        }
        return patterns.some((pattern) => path.matchesGlob(file, pattern));
      });
      expect(getUnitFastTestFilesForIncludePatterns(patterns, { dir })).toEqual(expected);
    }

    const extensionUnitFastFiles = getUnitFastTestFilesForIncludePatterns(
      ["extensions/**/*.test.ts"],
      { dir: "extensions" },
    );
    expect(getUnitFastTestFilesForIncludePatterns(["**/*.test.ts"], { dir: "extensions" })).toEqual(
      extensionUnitFastFiles,
    );
    expect(getUnitFastTestFilesForIncludePatterns(["!src/**/*.test.ts"])).toEqual(
      unitFastTestFiles,
    );
  });

  it("excludes unit-fast files from the older light lanes so full runs do not duplicate them", () => {
    const pluginSdkLight = createPluginSdkLightVitestConfig({});
    const commandsLight = createCommandsLightVitestConfig({});

    expect(unitFastTestFiles).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(requireTestConfig(pluginSdkLight).exclude).toContain(
      "plugin-sdk/provider-entry.test.ts",
    );
    expect(requireTestConfig(commandsLight).exclude).toContain("status-overview-values.test.ts");
  });
});
