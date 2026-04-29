import { describe, expect, it } from "vitest";
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

describe("unit-fast vitest lane", () => {
  it("runs cache-friendly tests without the reset-heavy runner or runtime setup", () => {
    const config = createUnitFastVitestConfig({});

    expect(config.test?.isolate).toBe(false);
    expect(config.test?.runner).toBeUndefined();
    expect(config.test?.setupFiles).toEqual([]);
    expect(config.test?.include).toContain(
      "src/agents/pi-tools.deferred-followup-guidance.test.ts",
    );
    expect(config.test?.include).toContain("src/acp/control-plane/runtime-cache.test.ts");
    expect(config.test?.include).toContain("src/acp/runtime/registry.test.ts");
    expect(config.test?.include).toContain("src/commands/status-overview-values.test.ts");
    expect(config.test?.include).toContain("src/entry.respawn.test.ts");
    expect(config.test?.include).toContain("src/entry.version-fast-path.test.ts");
    expect(config.test?.include).toContain("src/flows/doctor-startup-channel-maintenance.test.ts");
    expect(config.test?.include).toContain("src/crestodian/rescue-policy.test.ts");
    expect(config.test?.include).toContain("src/crestodian/assistant.configured.test.ts");
    expect(config.test?.include).toContain("src/flows/search-setup.test.ts");
    expect(config.test?.include).toContain("src/memory-host-sdk/host/mirror.test.ts");
    expect(config.test?.include).toContain("src/plugins/config-policy.test.ts");
    expect(config.test?.include).toContain("src/proxy-capture/proxy-server.test.ts");
    expect(config.test?.include).toContain("src/realtime-voice/agent-consult-tool.test.ts");
    expect(config.test?.include).toContain("src/sessions/session-lifecycle-events.test.ts");
    expect(config.test?.include).toContain("src/sessions/transcript-events.test.ts");
    expect(config.test?.include).toContain(
      "src/security/audit-channel-source-config-slack.test.ts",
    );
    expect(config.test?.include).toContain("src/security/audit-config-symlink.test.ts");
    expect(config.test?.include).toContain("src/security/audit-exec-sandbox-host.test.ts");
    expect(config.test?.include).toContain("src/security/audit-gateway.test.ts");
    expect(config.test?.include).toContain("src/security/audit-gateway-auth-selection.test.ts");
    expect(config.test?.include).toContain("src/security/audit-gateway-http-auth.test.ts");
    expect(config.test?.include).toContain("src/security/audit-gateway-tools-http.test.ts");
    expect(config.test?.include).toContain("src/security/audit-plugin-readonly-scope.test.ts");
    expect(config.test?.include).toContain("src/security/audit-loopback-logging.test.ts");
    expect(config.test?.include).toContain("src/security/audit-sandbox-browser.test.ts");
    expect(config.test?.include).toContain("src/ui-app-settings.agents-files-refresh.test.ts");
    expect(config.test?.include).toContain("src/video-generation/provider-registry.test.ts");
    expect(config.test?.include).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(config.test?.include).toContain("src/security/dangerous-config-flags.test.ts");
    expect(config.test?.include).toContain("src/security/context-visibility.test.ts");
    expect(config.test?.include).toContain("src/security/safe-regex.test.ts");
  });

  it("does not treat moved config paths as CLI include filters", () => {
    const config = createUnitFastVitestConfig(
      {},
      {
        argv: ["node", "vitest", "run", "--config", "test/vitest/vitest.unit-fast.config.ts"],
      },
    );

    expect(config.test?.include).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(config.test?.include).toContain("src/commands/status-overview-values.test.ts");
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
    const forcedAnalysis = analysis.filter((entry) => forcedUnitFastTestFiles.includes(entry.file));
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(forcedAnalysis).toHaveLength(forcedUnitFastTestFiles.length);
    for (const file of forcedUnitFastTestFiles) {
      expect(unitFastTestFiles).toContain(file);
      expect(isUnitFastTestFile(file)).toBe(true);
    }
    expect(forcedAnalysis.every((entry) => entry.forced && entry.unitFast)).toBe(true);
  });

  it("keeps broad audit candidates separate from automatically routed unit-fast tests", () => {
    const currentCandidates = collectUnitFastTestCandidates();
    const broadCandidates = collectBroadUnitFastTestCandidates();
    const broadAnalysis = collectUnitFastTestFileAnalysis(process.cwd(), { scope: "broad" });
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(currentCandidates.length).toBeGreaterThanOrEqual(unitFastTestFiles.length);
    expect(broadCandidates.length).toBeGreaterThan(currentCandidates.length);
    expect(broadAnalysis.filter((entry) => entry.unitFast).length).toBeGreaterThan(
      unitFastTestFiles.length,
    );
  });

  it("excludes unit-fast files from the older light lanes so full runs do not duplicate them", () => {
    const pluginSdkLight = createPluginSdkLightVitestConfig({});
    const commandsLight = createCommandsLightVitestConfig({});
    const unitFastTestFiles = getUnitFastTestFiles();

    expect(unitFastTestFiles).toContain("src/plugin-sdk/provider-entry.test.ts");
    expect(pluginSdkLight.test?.exclude).toContain("plugin-sdk/provider-entry.test.ts");
    expect(commandsLight.test?.exclude).toContain("status-overview-values.test.ts");
  });
});
