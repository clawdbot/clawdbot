import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createPluginSdkLightVitestConfig } from "./vitest/vitest.plugin-sdk-light.config.ts";
import {
  classifyUnitFastTestFileContent,
  collectBroadUnitFastTestCandidates,
  collectUnitFastTestCandidates,
  collectUnitFastTestFileAnalysis,
  forcedUnitFastTestFiles,
  getUnitFastTestFiles,
  isUnitFastTestFile,
  resolveUnitFastTestIncludePattern,
} from "./vitest/vitest.unit-fast-paths.mjs";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

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
  it("loads the config without recursively walking repo roots", () => {
    const script = `
      import fs from "node:fs";
      let readdirSyncCalls = 0;
      const originalReaddirSync = fs.readdirSync;
      fs.readdirSync = function patchedReaddirSync(...args) {
        readdirSyncCalls += 1;
        return originalReaddirSync.apply(this, args);
      };
      await import("./test/vitest/vitest.unit-fast.config.ts?io-probe=" + Date.now());
      console.log(readdirSyncCalls);
    `;
    const result = spawnNodeEvalSync(script, {
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      evalFlag: "-e",
      imports: ["tsx"],
    });

    expect(result.status, result.stderr).toBe(0);
    const numericOutputLines = result.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => Number(line.trim()))
      .filter(Number.isFinite);
    expect(numericOutputLines.length, result.stdout).toBeGreaterThan(0);
    expect(numericOutputLines.at(-1)).toBeLessThan(20);
  });

  it("runs cache-friendly tests without the reset-heavy runner or runtime setup", () => {
    const config = createUnitFastVitestConfig({});
    const testConfig = requireTestConfig(config);

    expect(testConfig.isolate).toBe(false);
    expect(testConfig.runner).toBeUndefined();
    expect(testConfig.setupFiles).toStrictEqual([]);
    expect(testConfig.include).toContain("src/agents/pi-tools.deferred-followup-guidance.test.ts");
    expect(testConfig.include).toContain("src/acp/control-plane/runtime-cache.test.ts");
    expect(testConfig.include).toContain("src/acp/runtime/registry.test.ts");
    expect(testConfig.include).toContain("src/commands/status-overview-values.test.ts");
    expect(testConfig.include).toContain("src/entry.respawn.test.ts");
    expect(testConfig.include).toContain("src/entry.version-fast-path.test.ts");
    expect(testConfig.include).toContain("src/flows/doctor-startup-channel-maintenance.test.ts");
    expect(testConfig.include).toContain("src/crestodian/rescue-policy.test.ts");
    expect(testConfig.include).toContain("src/crestodian/assistant.configured.test.ts");
    expect(testConfig.include).toContain("src/flows/search-setup.test.ts");
    expect(testConfig.include).toContain("src/memory-host-sdk/host/backend-config.test.ts");
    expect(testConfig.include).toContain("src/plugins/config-policy.test.ts");
    expect(testConfig.include).toContain("src/proxy-capture/proxy-server.test.ts");
    expect(testConfig.include).toContain("src/talk/agent-consult-tool.test.ts");
    expect(testConfig.include).toContain("src/sessions/session-lifecycle-events.test.ts");
    expect(testConfig.include).toContain("src/sessions/transcript-events.test.ts");
    expect(testConfig.include).toContain("src/security/audit-channel-source-config-slack.test.ts");
    expect(testConfig.include).toContain("src/security/audit-config-symlink.test.ts");
    expect(testConfig.include).toContain("src/security/audit-exec-sandbox-host.test.ts");
    expect(testConfig.include).toContain("src/security/audit-gateway.test.ts");
    expect(testConfig.include).toContain("src/security/audit-gateway-auth-selection.test.ts");
    expect(testConfig.include).toContain("src/security/audit-gateway-http-auth.test.ts");
    expect(testConfig.include).toContain("src/security/audit-gateway-tools-http.test.ts");
    expect(testConfig.include).toContain("src/security/audit-plugin-readonly-scope.test.ts");
    expect(testConfig.include).toContain("src/security/audit-loopback-logging.test.ts");
    expect(testConfig.include).toContain("src/security/audit-sandbox-browser.test.ts");
    expect(testConfig.include).toContain("src/ui-app-settings.agents-files-refresh.test.ts");
    expect(testConfig.include).toContain("src/video-generation/provider-registry.test.ts");
    expect(testConfig.include).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(testConfig.include).toContain("src/security/dangerous-config-flags.test.ts");
    expect(testConfig.include).toContain("src/security/context-visibility.test.ts");
    expect(testConfig.include).toContain("src/security/safe-regex.test.ts");
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

  it("keeps obvious stateful files out of the unit-fast lane", () => {
    expect(isUnitFastTestFile("src/plugin-sdk/temp-path.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/agents/sandbox.resolveSandboxContext.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/crestodian/assistant.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/plugins/install.npm-spec.test.ts")).toBe(false);
    expect(isUnitFastTestFile("src/secrets/runtime.test.ts")).toBe(false);
    expect(resolveUnitFastTestIncludePattern("src/plugin-sdk/temp-path.ts")).toBeNull();
    expect(classifyUnitFastTestFileContent("vi.resetModules(); await import('./x.js')")).toEqual([
      "module-mocking",
      "vitest-mock-api",
      "dynamic-import",
    ]);
  });

  it("routes unit-fast source files to their unit-fast sibling tests", () => {
    expect(resolveUnitFastTestIncludePattern("src/plugin-sdk/provider-entry.ts")).toBe(
      "src/plugin-sdk/provider-entry.test.ts",
    );
    expect(resolveUnitFastTestIncludePattern("src/commands/status-overview-values.ts")).toBe(
      "src/commands/status-overview-values.test.ts",
    );
  });

  it("routes audited stateful-looking tests through the fast lane", () => {
    const analysis = collectUnitFastTestFileAnalysis();
    const forcedFileSet = new Set(forcedUnitFastTestFiles);
    const forcedAnalysisCount = countMatching(analysis, (entry) => forcedFileSet.has(entry.file));
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(forcedAnalysisCount).toBe(forcedUnitFastTestFiles.length);
    for (const file of forcedUnitFastTestFiles) {
      expect(unitFastTestFiles).toContain(file);
      expect(isUnitFastTestFile(file)).toBe(true);
    }
    const unroutedForcedFiles = collectUnroutedForcedFiles(analysis, forcedFileSet);
    expect(unroutedForcedFiles).toStrictEqual([]);
  });

  it("keeps broad audit candidates separate from automatically routed unit-fast tests", () => {
    const currentCandidates = collectUnitFastTestCandidates();
    const broadCandidates = collectBroadUnitFastTestCandidates();
    const broadAnalysis = collectUnitFastTestFileAnalysis(process.cwd(), { scope: "broad" });
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(currentCandidates.length).toBeGreaterThanOrEqual(unitFastTestFiles.length);
    expect(broadCandidates.length).toBeGreaterThan(currentCandidates.length);
    expect(countMatching(broadAnalysis, (entry) => entry.unitFast)).toBeGreaterThan(
      unitFastTestFiles.length,
    );
  });

  it("excludes unit-fast files from the older light lanes so full runs do not duplicate them", () => {
    const pluginSdkLight = createPluginSdkLightVitestConfig({});
    const commandsLight = createCommandsLightVitestConfig({});
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(unitFastTestFiles).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(requireTestConfig(pluginSdkLight).exclude).toContain(
      "plugin-sdk/provider-entry.test.ts",
    );
    expect(requireTestConfig(commandsLight).exclude).toContain("status-overview-values.test.ts");
  });
});
