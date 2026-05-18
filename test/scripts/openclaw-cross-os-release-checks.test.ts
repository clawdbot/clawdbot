import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";
import {
  agentOutputHasExpectedOkMarker,
  buildCrossOsReleaseSmokePluginAllowlist,
  buildPackagedUpgradeUpdateArgs,
  buildReleaseOnboardArgs,
  buildWindowsDevUpdateToolchainCheckScript,
  buildWindowsFreshShellVersionCheckScript,
  buildInstalledBrowserOverrideImportProbeScript,
  buildNpmGlobalInstallArgs,
  buildWindowsPathBootstrapScript,
  canConnectToLoopbackPort,
  buildDiscordSmokeGuildsConfig,
  buildRealUpdateEnv,
  CROSS_OS_GATEWAY_READY_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
  CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE,
  CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS,
  CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS,
  CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS,
  CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS,
  CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS,
  CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  CROSS_OS_COMMAND_HEARTBEAT_SECONDS,
  isImmutableReleaseRef,
  isRecoverableWindowsPackagedUpgradeSwapCleanupFailure,
  isRecoverableWindowsPackagedUpgradeTimeoutError,
  looksLikeReleaseVersionRef,
  normalizeRequestedRef,
  normalizeWindowsCommandShimPath,
  normalizeWindowsInstalledCliPath,
  parseCrossOsSuiteFilter,
  parseArgs,
  packageHasScript,
  readInstalledVersion,
  readRunnerOverrideEnv,
  resolveExplicitBaselineVersion,
  resolveInstalledPackageRootFromCliPath,
  resolveProviderConfig,
  resolveDevUpdateVerificationRef,
  resolveInstalledPrefixDirFromCliPath,
  resolvePublishedInstallerUrl,
  resolveRequestedSuites,
  resolveRunnerMatrix,
  resolveStaticFileContentType,
  shouldExerciseManagedGatewayLifecycleAfterInstall,
  shouldRunPackagedUpgradeStatusProbe,
  shouldRunWindowsInstalledBrowserOverrideImportSmoke,
  shouldSkipInstallerDaemonHealthCheck,
  shouldStopManagedGatewayBeforeManualFallback,
  shouldRunMainChannelDevUpdate,
  shouldRetryCrossOsAgentTurnError,
  shouldSkipOptionalCrossOsAgentTurnError,
  shouldUseManagedGatewayForInstallerRuntime,
  shouldUseManagedGatewayService,
  verifyDevUpdateStatus,
  verifyPackagedUpgradeUpdateResult,
  writePackageDistInventoryForCandidate,
} from "../../scripts/openclaw-cross-os-release-checks.ts";

describe("scripts/openclaw-cross-os-release-checks", () => {
  it("keeps dashboard smoke patient enough for cold packaged gateway startup", () => {
    expect(CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("keeps gateway RPC status probes patient enough for live release startup", () => {
    expect(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS).toBeGreaterThan(
      CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
    );
    expect(CROSS_OS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    expect(CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it("gives the Windows packaged updater wrapper enough headroom for OpenClaw timeout output", () => {
    expect(CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS).toBeLessThanOrEqual(10 * 60);
    expect(CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS).toBeGreaterThan(
      CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS * 1000,
    );
    expect(
      CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS -
        CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS * 1000,
    ).toBeGreaterThanOrEqual(2 * 60 * 1000);
    expect(CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS).toBeLessThanOrEqual(
      12 * 60 * 1000,
    );
  });

  it("prints command heartbeats before long release commands hit job timeouts", () => {
    expect(CROSS_OS_COMMAND_HEARTBEAT_SECONDS).toBeGreaterThan(0);
    expect(CROSS_OS_COMMAND_HEARTBEAT_SECONDS).toBeLessThanOrEqual(60);
  });

  it("accepts OK agent output from the captured log when stdout is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-agent-output-"));
    try {
      const logPath = join(dir, "agent.log");
      writeFileSync(
        logPath,
        [
          "2026-04-24T15:00:00.000Z command stdout",
          JSON.stringify({
            finalAssistantVisibleText: "OK",
            payloads: [{ type: "text", text: "OK" }],
          }),
        ].join("\n"),
      );

      expect(agentOutputHasExpectedOkMarker("", { logPath })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries transient agent-turn failures", () => {
    expect(
      shouldRetryCrossOsAgentTurnError(
        new Error("Agent output did not contain the expected OK marker."),
      ),
    ).toBe(true);
    expect(
      shouldRetryCrossOsAgentTurnError(
        new Error(
          "The model did not produce a response before the model idle timeout. Please try again.",
        ),
      ),
    ).toBe(true);
    expect(
      shouldRetryCrossOsAgentTurnError(
        new Error("gateway request timeout for agent after 210000ms"),
      ),
    ).toBe(true);
    expect(
      shouldRetryCrossOsAgentTurnError(
        new Error("Command timed out and could not be terminated cleanly"),
      ),
    ).toBe(true);
  });

  it("skips optional live agent turns only for model availability failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-agent-skip-"));
    try {
      const logPath = join(dir, "agent.log");
      writeFileSync(
        logPath,
        JSON.stringify({
          status: "timeout",
          result: {
            payloads: [
              {
                text: "Request timed out before a response was generated.",
              },
            ],
          },
        }),
      );

      expect(
        shouldSkipOptionalCrossOsAgentTurnError(
          new Error("Agent output did not contain the expected OK marker."),
          logPath,
        ),
      ).toBe(true);
      expect(
        shouldSkipOptionalCrossOsAgentTurnError(
          new Error("document-extract: failed to install bundled runtime deps"),
          logPath,
        ),
      ).toBe(false);
      expect(
        shouldSkipOptionalCrossOsAgentTurnError(
          new Error("Agent output did not contain the expected OK marker."),
          join(dir, "missing.log"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows cross-OS provider smoke models to use faster CI overrides", () => {
    expect(
      resolveProviderConfig("openai", {
        OPENCLAW_CROSS_OS_OPENAI_MODEL: "openai/gpt-5.4-mini",
      })?.model,
    ).toBe("openai/gpt-5.4-mini");
    expect(
      resolveProviderConfig("openai", {
        OPENCLAW_CROSS_OS_MODEL: "openai/gpt-5.4-nano",
      })?.model,
    ).toBe("openai/gpt-5.4-nano");
    expect(resolveProviderConfig("openai", {})?.model).toBe("openai/gpt-5.5");
  });

  it("keeps release cross-OS OpenAI smoke on GPT-5.5", () => {
    const workflow = readFileSync(
      ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
      "utf8",
    );
    const releaseChecks = readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8");

    expect(workflow).toContain(
      "OPENCLAW_CROSS_OS_OPENAI_MODEL: ${{ inputs.openai_model || vars.OPENCLAW_CROSS_OS_OPENAI_MODEL || 'openai/gpt-5.5' }}",
    );
    expect(releaseChecks).toContain("openai_model: openai/gpt-5.5");
  });

  it("keeps release smoke plugin allowlists focused on agent-turn essentials", () => {
    const allowlist = buildCrossOsReleaseSmokePluginAllowlist({ extensionId: "openai" });

    expect(allowlist).toEqual([
      "openai",
      "acpx",
      "bonjour",
      "browser",
      "device-pair",
      "phone-control",
      "talk-voice",
    ]);
  });

  it("can stage packaged-upgrade baselines without npm lifecycle scripts", () => {
    expect(buildNpmGlobalInstallArgs("openclaw@2026.5.2", { ignoreScripts: true })).toEqual([
      "install",
      "-g",
      "openclaw@2026.5.2",
      "--omit=dev",
      "--no-fund",
      "--no-audit",
      "--ignore-scripts",
      "--loglevel=notice",
    ]);
  });

  it("keeps packaged-upgrade release updates out of service restart flow", () => {
    const args = buildPackagedUpgradeUpdateArgs("http://127.0.0.1:49152/openclaw-current.tgz");
    expect(args.slice(0, 6)).toEqual([
      "update",
      "--tag",
      "http://127.0.0.1:49152/openclaw-current.tgz",
      "--yes",
      "--json",
      "--no-restart",
    ]);
    expect(args.at(-2)).toBe("--timeout");
  });

  it("keeps cross-OS live smoke agent turns on GPT-5-safe timeouts and minimal context", () => {
    const source = readFileSync("scripts/openclaw-cross-os-release-checks.ts", "utf8");
    const providerOverride = "models.providers.${params.providerConfig.extensionId}";

    expect(CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE).toBe("minimal");
    expect(source).toContain('"--thinking",\n    "off"');
    expect(source.match(/"tools\.profile", CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE/g)).toHaveLength(2);
    expect(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(600);
    expect(source).toContain("buildReleaseProviderConfigOverride");
    expect(source).toContain("models: []");
    expect(source).toContain('agentRuntime: { id: "pi" }');
    expect(source).toContain('"--merge"');
    expect(source).toContain(providerOverride);
    expect(source).not.toContain("models.providers.${params.providerConfig.extensionId}.baseUrl");
    expect(source).toContain('"--timeout",\n    String(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS)');
    const agentTurnArgCalls = source.match(/buildReleaseAgentTurnArgs\(sessionId\)/g) ?? [];
    expect(agentTurnArgCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("treats explicit empty-string args as values instead of boolean flags", () => {
    expect(parseArgs(["--ubuntu-runner", "", "--mode", "both"])).toEqual({
      "ubuntu-runner": "",
      mode: "both",
    });
  });

  it("detects release refs and keeps branch refs out of release-only logic", () => {
    expect(looksLikeReleaseVersionRef("2026.4.5")).toBe(true);
    expect(looksLikeReleaseVersionRef("refs/tags/v2026.4.5-beta.1")).toBe(true);
    expect(looksLikeReleaseVersionRef("v2026.4.5-beta.1")).toBe(true);
    expect(looksLikeReleaseVersionRef("refs/tags/v2026.4.5-alpha.1")).toBe(true);
    expect(looksLikeReleaseVersionRef("v2026.4.5-alpha.1")).toBe(true);
    expect(looksLikeReleaseVersionRef("v2026.4.7-1")).toBe(true);
    expect(looksLikeReleaseVersionRef("main")).toBe(false);
    expect(looksLikeReleaseVersionRef("codex/cross-os-release-checks")).toBe(false);
  });

  it("normalizes full Git refs before suite and update decisions", () => {
    expect(normalizeRequestedRef(" refs/heads/main ")).toBe("main");
    expect(normalizeRequestedRef("refs/tags/v2026.4.14")).toBe("v2026.4.14");
    expect(isImmutableReleaseRef("refs/tags/test-tag")).toBe(true);
    expect(resolveRequestedSuites("both", "refs/tags/v2026.4.14")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
    expect(resolveRequestedSuites("both", "refs/tags/test-tag")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
    expect(shouldRunMainChannelDevUpdate("refs/heads/main")).toBe(true);
    expect(shouldRunMainChannelDevUpdate("refs/tags/main")).toBe(false);
  });

  it("skips the dev-update suite for immutable release refs", () => {
    expect(resolveRequestedSuites("both", "v2026.4.5")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
  });

  it("skips dev-update for non-main branch validation refs", () => {
    expect(resolveRequestedSuites("both", "codex/cross-os-release-checks")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
  });

  it("keeps dev-update enabled for main validation refs", () => {
    expect(resolveRequestedSuites("both", "main")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
      "dev-update",
    ]);
  });

  it("skips dev-update for pinned commit refs", () => {
    expect(resolveRequestedSuites("both", "08753a1d793c040b101c8a26c43445dbbab14995")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
  });

  it("builds a suite-aware runner matrix with the beefy Windows default", () => {
    const matrix = resolveRunnerMatrix({
      mode: "both",
      ref: "main",
      ubuntuRunner: "",
      windowsRunner: "",
      macosRunner: "",
      varUbuntuRunner: "",
      varWindowsRunner: "",
      varMacosRunner: "",
    });

    expect(matrix.include).toHaveLength(12);
    expect(
      matrix.include.find((entry) => entry.os_id === "windows" && entry.suite === "dev-update"),
    ).toEqual({
      artifact_name: "windows",
      display_name: "Windows",
      lane: "upgrade",
      os_id: "windows",
      runner: "blacksmith-32vcpu-windows-2025",
      suite: "dev-update",
      suite_label: "dev update",
    });
    expect(
      matrix.include.find((entry) => entry.os_id === "ubuntu" && entry.suite === "installer-fresh"),
    ).toEqual({
      artifact_name: "linux",
      display_name: "Linux",
      lane: "fresh",
      os_id: "ubuntu",
      runner: "blacksmith-8vcpu-ubuntu-2404",
      suite: "installer-fresh",
      suite_label: "installer fresh",
    });
    expect(
      matrix.include.find((entry) => entry.os_id === "macos" && entry.suite === "packaged-fresh"),
    ).toEqual({
      artifact_name: "macos",
      display_name: "macOS",
      lane: "fresh",
      os_id: "macos",
      runner: "blacksmith-6vcpu-macos-latest",
      suite: "packaged-fresh",
      suite_label: "packaged fresh",
    });
  });

  it("keeps matrix resolution independent of package dependency imports", () => {
    const source = readFileSync("scripts/openclaw-cross-os-release-checks.ts", "utf8");
    const topLevelImports = source.slice(0, source.indexOf("const SCRIPT_PATH"));

    expect(topLevelImports).not.toContain("package-dist-inventory");
    expect(source).toContain("function assertNoLegacyPluginDependencyStagingDebris(packageRoot)");
  });

  it("filters the cross-OS runner matrix to a focused OS suite", () => {
    const matrix = resolveRunnerMatrix({
      mode: "both",
      ref: "main",
      suiteFilter: "windows/packaged-upgrade",
      ubuntuRunner: "",
      windowsRunner: "",
      macosRunner: "",
      varUbuntuRunner: "",
      varWindowsRunner: "",
      varMacosRunner: "",
    });

    expect(matrix.include).toEqual([
      {
        artifact_name: "windows",
        display_name: "Windows",
        lane: "upgrade",
        os_id: "windows",
        runner: "blacksmith-32vcpu-windows-2025",
        suite: "packaged-upgrade",
        suite_label: "packaged upgrade",
      },
    ]);
  });

  it("filters the cross-OS runner matrix by suite across platforms", () => {
    const matrix = resolveRunnerMatrix({
      mode: "both",
      ref: "main",
      suiteFilter: "packaged-fresh",
      ubuntuRunner: "",
      windowsRunner: "",
      macosRunner: "",
      varUbuntuRunner: "",
      varWindowsRunner: "",
      varMacosRunner: "",
    });

    expect(matrix.include).toHaveLength(3);
    expect(matrix.include.map((entry) => entry.os_id).toSorted()).toEqual([
      "macos",
      "ubuntu",
      "windows",
    ]);
    expect(matrix.include.map((entry) => entry.suite)).toEqual([
      "packaged-fresh",
      "packaged-fresh",
      "packaged-fresh",
    ]);
  });

  it("rejects unsupported cross-OS suite filter tokens", () => {
    expect(() => parseCrossOsSuiteFilter("windows/nope")).toThrow(
      /Unsupported cross_os_suite_filter/u,
    );
  });

  it("can rebuild the Windows PATH with or without current-process entries", () => {
    expect(buildWindowsPathBootstrapScript()).toContain("@($userPath, $machinePath, $env:Path)");
    const persistedOnlyScript = buildWindowsPathBootstrapScript({
      includeCurrentProcessPath: false,
    });
    expect(persistedOnlyScript).toContain("@($userPath, $machinePath)");
    expect(persistedOnlyScript).not.toContain("@($userPath, $machinePath, $env:Path)");
  });

  it("prefers the freshly installed Windows CLI under npm's prefix before PATH lookup", () => {
    const script = buildWindowsFreshShellVersionCheckScript({
      expectedNeedle: "2026.4.14",
    });
    expect(script).toContain(buildWindowsPathBootstrapScript());
    expect(script).not.toContain(
      buildWindowsPathBootstrapScript({ includeCurrentProcessPath: false }),
    );
    expect(script).toContain("Get-Command npm.cmd -ErrorAction SilentlyContinue");
    expect(script).toContain('$env:Path = "$npmPrefix;$env:Path"');
    expect(script).toContain("(Join-Path $npmPrefix 'openclaw.cmd')");
    expect(script).toContain("$cmd = Get-Command openclaw -ErrorAction Stop");
  });

  it("keeps Windows dev-update toolchain checks compatible with setup-node PATH shims", () => {
    const script = buildWindowsDevUpdateToolchainCheckScript();
    expect(script).toContain(buildWindowsPathBootstrapScript());
    expect(script).not.toContain(
      buildWindowsPathBootstrapScript({ includeCurrentProcessPath: false }),
    );
    expect(script).toContain("$pnpmPath = Resolve-CommandPath 'pnpm'");
    expect(script).toContain("$corepackPath = Resolve-CommandPath 'corepack'");
    expect(script).toContain("$npmPath = Resolve-CommandPath 'npm'");
  });

  it("prefers workflow-injected runner override env names over legacy ones", () => {
    expect(
      readRunnerOverrideEnv({
        VAR_UBUNTU_RUNNER: "workflow-linux",
        VAR_WINDOWS_RUNNER: "workflow-windows",
        VAR_MACOS_RUNNER: "workflow-macos",
        OPENCLAW_RELEASE_CHECKS_UBUNTU_RUNNER: "legacy-linux",
        OPENCLAW_RELEASE_CHECKS_WINDOWS_RUNNER: "legacy-windows",
        OPENCLAW_RELEASE_CHECKS_MACOS_RUNNER: "legacy-macos",
      }),
    ).toEqual({
      varUbuntuRunner: "workflow-linux",
      varWindowsRunner: "workflow-windows",
      varMacosRunner: "workflow-macos",
    });
  });

  it("falls back to legacy runner override env names when workflow vars are blank", () => {
    expect(
      readRunnerOverrideEnv({
        VAR_UBUNTU_RUNNER: "",
        VAR_WINDOWS_RUNNER: " ",
        VAR_MACOS_RUNNER: "",
        OPENCLAW_RELEASE_CHECKS_UBUNTU_RUNNER: "legacy-linux",
        OPENCLAW_RELEASE_CHECKS_WINDOWS_RUNNER: "legacy-windows",
        OPENCLAW_RELEASE_CHECKS_MACOS_RUNNER: "legacy-macos",
      }),
    ).toEqual({
      varUbuntuRunner: "legacy-linux",
      varWindowsRunner: "legacy-windows",
      varMacosRunner: "legacy-macos",
    });
  });

  it("serves installer scripts as UTF-8 text and package payloads as binary", () => {
    expect(resolveStaticFileContentType("scripts/install.sh")).toBe("text/plain; charset=utf-8");
    expect(resolveStaticFileContentType("scripts/install.ps1")).toBe("text/plain; charset=utf-8");
    expect(resolveStaticFileContentType("openclaw-2026.4.14.tgz")).toBe("application/octet-stream");
  });

  it("uses the published installer URLs for native installer lanes", () => {
    expect(resolvePublishedInstallerUrl("darwin")).toBe("https://openclaw.ai/install.sh");
    expect(resolvePublishedInstallerUrl("linux")).toBe("https://openclaw.ai/install.sh");
    expect(resolvePublishedInstallerUrl("win32")).toBe("https://openclaw.ai/install.ps1");
  });

  it("uses managed gateway services only on native Windows runners", () => {
    expect(shouldUseManagedGatewayService("win32")).toBe(true);
    expect(shouldUseManagedGatewayService("darwin")).toBe(false);
    expect(shouldUseManagedGatewayService("linux")).toBe(false);
  });

  it("skips workspace bootstrap during release onboarding", () => {
    expect(
      buildReleaseOnboardArgs({
        authChoice: "openai-api-key",
        gatewayPort: 34111,
        skipHealth: true,
      }),
    ).toEqual([
      "onboard",
      "--non-interactive",
      "--mode",
      "local",
      "--auth-choice",
      "openai-api-key",
      "--secret-input-mode",
      "ref",
      "--gateway-port",
      "34111",
      "--gateway-bind",
      "loopback",
      "--skip-skills",
      "--skip-bootstrap",
      "--accept-risk",
      "--json",
      "--skip-health",
    ]);
  });

  it("keeps the Windows installer runtime on the manual gateway after managed lifecycle checks", () => {
    expect(shouldExerciseManagedGatewayLifecycleAfterInstall("win32")).toBe(true);
    expect(shouldUseManagedGatewayForInstallerRuntime("win32")).toBe(false);
    expect(shouldExerciseManagedGatewayLifecycleAfterInstall("darwin")).toBe(false);
    expect(shouldUseManagedGatewayForInstallerRuntime("darwin")).toBe(false);
  });

  it("stops the managed gateway before the manual fallback only on Windows", () => {
    expect(shouldStopManagedGatewayBeforeManualFallback("win32")).toBe(true);
    expect(shouldStopManagedGatewayBeforeManualFallback("darwin")).toBe(false);
    expect(shouldStopManagedGatewayBeforeManualFallback("linux")).toBe(false);
  });

  it("skips daemon health during installed onboarding only on native Windows", () => {
    expect(shouldSkipInstallerDaemonHealthCheck("win32")).toBe(true);
    expect(shouldSkipInstallerDaemonHealthCheck("darwin")).toBe(false);
    expect(shouldSkipInstallerDaemonHealthCheck("linux")).toBe(false);
  });

  it("runs the installed browser override import smoke only on native Windows", () => {
    expect(shouldRunWindowsInstalledBrowserOverrideImportSmoke("win32")).toBe(true);
    expect(shouldRunWindowsInstalledBrowserOverrideImportSmoke("darwin")).toBe(false);
    expect(shouldRunWindowsInstalledBrowserOverrideImportSmoke("linux")).toBe(false);

    const script = buildInstalledBrowserOverrideImportProbeScript();
    expect(script).toContain('from "openclaw/plugin-sdk/plugin-runtime"');
    expect(script).toContain('overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE"');
    expect(script).toContain("startBrowserControlService");
    expect(script).toContain("stopBrowserControlService");
    expect(script).toContain("Browser control override start sentinel was not written.");

    const installedScript = buildInstalledBrowserOverrideImportProbeScript(
      "file:///C:/Users/runner/AppData/Roaming/npm/node_modules/openclaw/dist/plugin-sdk/plugin-runtime.js",
    );
    expect(installedScript).toContain(
      'from "file:///C:/Users/runner/AppData/Roaming/npm/node_modules/openclaw/dist/plugin-sdk/plugin-runtime.js"',
    );
    expect(readFileSync("scripts/openclaw-cross-os-release-checks.ts", "utf8")).toContain(
      "OPENCLAW_BROWSER_CONTROL_MODULE: pathToFileURL(overridePath).href",
    );
  });

  it("normalizes Windows installed CLI paths to the cmd shim", () => {
    expect(
      normalizeWindowsInstalledCliPath(
        String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.ps1`,
      ),
    ).toBe(String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.cmd`);
    expect(
      normalizeWindowsInstalledCliPath(
        String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.cmd`,
      ),
    ).toBe(String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.cmd`);
  });

  it("normalizes generic Windows PowerShell shims to cmd shims", () => {
    expect(normalizeWindowsCommandShimPath(String.raw`C:\Program Files\nodejs\pnpm.ps1`)).toBe(
      String.raw`C:\Program Files\nodejs\pnpm.cmd`,
    );
    expect(normalizeWindowsCommandShimPath(String.raw`C:\Program Files\nodejs\corepack.ps1`)).toBe(
      String.raw`C:\Program Files\nodejs\corepack.cmd`,
    );
    expect(normalizeWindowsCommandShimPath(String.raw`C:\Program Files\nodejs\node.exe`)).toBe(
      String.raw`C:\Program Files\nodejs\node.exe`,
    );
  });

  it("derives the installed prefix from resolved CLI paths", () => {
    expect(
      resolveInstalledPrefixDirFromCliPath(
        String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.ps1`,
        "win32",
      ),
    ).toBe(String.raw`C:\Users\runner\AppData\Roaming\npm`);
    expect(
      resolveInstalledPrefixDirFromCliPath("/Users/runner/.npm-global/bin/openclaw", "darwin"),
    ).toBe("/Users/runner/.npm-global");
  });

  it("resolves Linux npm package roots when the CLI is a user-local shim", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-linux-home-"));
    try {
      const packageRoot = join(homeDir, ".npm-global", "lib", "node_modules", "openclaw");
      const distDir = join(packageRoot, "dist");
      const cliDir = join(homeDir, ".local", "bin");
      mkdirSync(distDir, { recursive: true });
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
      writeFileSync(join(distDir, "entry.js"), "#!/usr/bin/env node\n");

      expect(
        resolveInstalledPackageRootFromCliPath(join(cliDir, "openclaw"), "linux", {
          HOME: homeDir,
        }),
      ).toBe(packageRoot);

      rmSync(join(cliDir, "openclaw"), { force: true });
      symlinkSync(join(distDir, "entry.js"), join(cliDir, "openclaw"));

      expect(
        resolveInstalledPackageRootFromCliPath(join(cliDir, "openclaw"), "linux", {
          HOME: homeDir,
        }),
      ).toBe(realpathSync(packageRoot));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("detects whether a managed gateway listener is still reachable on loopback", async () => {
    const server = createNetServer();
    await new Promise((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(await canConnectToLoopbackPort(port)).toBe(true);
    await new Promise((resolvePromise) => {
      server.close(resolvePromise);
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await canConnectToLoopbackPort(port, 100))) {
        return;
      }
      await delay(25);
    }
    expect(await canConnectToLoopbackPort(port, 100)).toBe(false);
  });

  it("writes Discord smoke config using the strict guild channel schema", () => {
    expect(buildDiscordSmokeGuildsConfig("guild-123", "channel-456")).toEqual({
      "guild-123": {
        channels: {
          "channel-456": {
            enabled: true,
            requireMention: false,
          },
        },
      },
    });
  });

  it("keeps the dev-update lane for main only", () => {
    expect(shouldRunMainChannelDevUpdate("main")).toBe(true);
    expect(shouldRunMainChannelDevUpdate("08753a1d793c040b101c8a26c43445dbbab14995")).toBe(false);
    expect(shouldRunMainChannelDevUpdate(" codex/cross-os-release-checks-full-native-e2e ")).toBe(
      false,
    );
    expect(shouldRunMainChannelDevUpdate("v2026.4.14")).toBe(false);
  });

  it("verifies main dev updates against the prepared source sha when available", () => {
    expect(resolveDevUpdateVerificationRef("main")).toBe("main");
    expect(
      resolveDevUpdateVerificationRef("main", "08753a1d793c040b101c8a26c43445dbbab14995"),
    ).toBe("08753a1d793c040b101c8a26c43445dbbab14995");
    expect(
      resolveDevUpdateVerificationRef(
        "refs/heads/main",
        "08753a1d793c040b101c8a26c43445dbbab14995",
      ),
    ).toBe("08753a1d793c040b101c8a26c43445dbbab14995");
    expect(resolveDevUpdateVerificationRef("codex/cross-os-release-checks-full-native-e2e")).toBe(
      "codex/cross-os-release-checks-full-native-e2e",
    );
  });

  it("drops the bundled plugin postinstall disable flag for real updater calls", () => {
    expect(
      buildRealUpdateEnv({
        FOO: "bar",
        NODE_COMPILE_CACHE: "/tmp/stale-openclaw-cache",
        OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1",
      }),
    ).toEqual({
      FOO: "bar",
      NODE_DISABLE_COMPILE_CACHE: "1",
    });
  });

  it("rejects a successful packaged update followed by an old self-swapped process import miss", () => {
    expect(() =>
      verifyPackagedUpgradeUpdateResult(
        {
          exitCode: 1,
          stdout: JSON.stringify({
            status: "ok",
            after: { version: "2026.4.27" },
            steps: [{ name: "global update", exitCode: 0 }],
          }),
          stderr:
            "[openclaw] Failed to start CLI: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/prefix/lib/node_modules/openclaw/dist/memory-state-old.js'",
        },
        { candidateVersion: "2026.4.27" },
      ),
    ).toThrow(/Packaged upgrade failed/u);
  });

  it("rejects packaged update failures before the candidate package lands", () => {
    expect(() =>
      verifyPackagedUpgradeUpdateResult(
        {
          exitCode: 1,
          stdout: JSON.stringify({
            status: "ok",
            after: { version: "2026.4.26" },
            steps: [{ name: "global update", exitCode: 0 }],
          }),
          stderr:
            "[openclaw] Failed to start CLI: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/prefix/lib/node_modules/openclaw/dist/memory-state-old.js'",
        },
        { candidateVersion: "2026.4.27" },
      ),
    ).toThrow(/Packaged upgrade failed/u);
  });

  it("rejects packaged update failures with unsuccessful update steps", () => {
    expect(() =>
      verifyPackagedUpgradeUpdateResult(
        {
          exitCode: 1,
          stdout: JSON.stringify({
            status: "ok",
            after: { version: "2026.4.27" },
            steps: [{ name: "global update", exitCode: 1 }],
          }),
          stderr:
            "[openclaw] Failed to start CLI: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/prefix/lib/node_modules/openclaw/dist/memory-state-old.js'",
        },
        { candidateVersion: "2026.4.27" },
      ),
    ).toThrow(/Packaged upgrade failed/u);
  });

  it("recognizes the shipped Windows updater native-module backup cleanup failure", () => {
    expect(
      isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(
        {
          exitCode: 1,
          stdout: JSON.stringify({
            status: "error",
            reason: "global install swap",
            after: { version: "2026.5.2" },
            steps: [
              {
                name: "global install swap",
                exitCode: 1,
                stderrTail:
                  "EPERM: operation not permitted, unlink 'C:\\Users\\runner\\prefix\\node_modules\\.openclaw-5748-1777776287462\\node_modules\\@mariozechner\\clipboard-win32-x64-msvc\\clipboard.win32-x64-msvc.node'",
              },
            ],
          }),
          stderr: "",
        },
        "win32",
      ),
    ).toBe(true);
  });

  it("recognizes the shipped Windows updater packaged-upgrade timeout", () => {
    const error = new Error(
      "Command timed out: C:\\hostedtoolcache\\windows\\node\\24.15.0\\x64\\node.exe C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\openclaw-upgrade-q9DsA7\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-2026.5.4-beta.1.tgz --yes --json --no-restart --timeout 1500",
    );

    expect(isRecoverableWindowsPackagedUpgradeTimeoutError(error, "win32")).toBe(true);
    expect(
      isRecoverableWindowsPackagedUpgradeTimeoutError(
        new Error(
          "Command timed out: C:\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-current.tgz --yes --json --timeout 1500",
        ),
        "win32",
      ),
    ).toBe(true);
    expect(isRecoverableWindowsPackagedUpgradeTimeoutError(error, "linux")).toBe(false);
    expect(
      isRecoverableWindowsPackagedUpgradeTimeoutError(
        new Error("Command timed out: node openclaw.mjs update --tag openclaw@beta"),
        "win32",
      ),
    ).toBe(false);
  });

  it("skips the packaged upgrade status probe after the Windows fallback install", () => {
    expect(
      shouldRunPackagedUpgradeStatusProbe({
        platform: "win32",
        usedWindowsPackagedUpgradeFallback: true,
      }),
    ).toBe(false);
    expect(
      shouldRunPackagedUpgradeStatusProbe({
        platform: "win32",
        usedWindowsPackagedUpgradeFallback: false,
      }),
    ).toBe(true);
    expect(
      shouldRunPackagedUpgradeStatusProbe({
        platform: "linux",
        usedWindowsPackagedUpgradeFallback: true,
      }),
    ).toBe(true);
  });

  it("does not recover unrelated packaged update failures", () => {
    expect(
      isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(
        {
          exitCode: 1,
          stdout: JSON.stringify({
            status: "error",
            reason: "global install swap",
            steps: [{ name: "global install swap", exitCode: 1, stderrTail: "ENOENT: missing" }],
          }),
          stderr: "",
        },
        "win32",
      ),
    ).toBe(false);
    expect(
      isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(
        {
          exitCode: 1,
          stdout:
            "EPERM: operation not permitted, unlink '/tmp/prefix/node_modules/.openclaw-1-2/native.node'",
          stderr: "",
        },
        "linux",
      ),
    ).toBe(false);
  });

  it("only treats pinned baseline specs as exact installer version assertions", () => {
    expect(resolveExplicitBaselineVersion("")).toBe("");
    expect(resolveExplicitBaselineVersion("openclaw@latest")).toBe("");
    expect(resolveExplicitBaselineVersion("openclaw@2026.4.10")).toBe("2026.4.10");
    expect(resolveExplicitBaselineVersion("2026.4.10")).toBe("2026.4.10");
  });

  it("reads an installed baseline version without requiring build metadata", () => {
    const prefixDir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-installed-version-"));
    try {
      const packageRoot =
        process.platform === "win32"
          ? join(prefixDir, "node_modules", "openclaw")
          : join(prefixDir, "lib", "node_modules", "openclaw");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.4.10",
        }),
        "utf8",
      );

      expect(readInstalledVersion(prefixDir)).toBe("2026.4.10");
    } finally {
      rmSync(prefixDir, { recursive: true, force: true });
    }
  });

  it("treats missing package scripts as optional in older refs", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "openclaw-cross-os-scripts-"));
    try {
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          scripts: {
            build: "pnpm build",
          },
        }),
        "utf8",
      );

      expect(packageHasScript(packageRoot, "build")).toBe(true);
      expect(packageHasScript(packageRoot, "ui:build")).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects legacy plugin dependency staging debris before candidate inventory generation", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "openclaw-cross-os-stage-debris-"));
    try {
      mkdirSync(
        join(packageRoot, "dist", "Extensions", "demo", ".OpenClaw-Install-Stage", "node_modules"),
        { recursive: true },
      );
      writeFileSync(
        join(packageRoot, "dist", "Extensions", "demo", ".OpenClaw-Install-Stage", "package.json"),
        "{}\n",
        "utf8",
      );

      await expect(
        writePackageDistInventoryForCandidate({
          sourceDir: packageRoot,
          logPath: join(packageRoot, "npm-pack-dry-run.log"),
        }),
      ).rejects.toThrow("unexpected legacy plugin dependency staging debris");
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("omits local build metadata from candidate package inventories", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "openclaw-cross-os-local-stamps-"));
    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw-fixture", version: "0.0.0", files: ["dist/"] }),
        "utf8",
      );
      writeFileSync(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
      for (const relativePath of LOCAL_BUILD_METADATA_DIST_PATHS) {
        writeFileSync(join(packageRoot, relativePath), "{}\n", "utf8");
      }

      await writePackageDistInventoryForCandidate({
        sourceDir: packageRoot,
        logPath: join(packageRoot, "npm-pack-dry-run.log"),
      });

      expect(
        JSON.parse(readFileSync(join(packageRoot, "dist", "postinstall-inventory.json"), "utf8")),
      ).toEqual(["dist/index.js"]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts a git main dev-channel update status payload", () => {
    expect(
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "git",
            git: {
              branch: "main",
            },
          },
          channel: {
            value: "dev",
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts a git dev-channel payload for a requested non-main branch", () => {
    expect(
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "git",
            git: {
              branch: "codex/cross-os-release-checks-full-native-e2e",
              sha: "08753a1d793c040b101c8a26c43445dbbab14995",
            },
          },
          channel: {
            value: "dev",
          },
        }),
        { ref: "codex/cross-os-release-checks-full-native-e2e" },
      ),
    ).toBeUndefined();
  });

  it("accepts a git dev-channel payload pinned to a prepared source sha", () => {
    expect(
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "git",
            git: {
              branch: "main",
              sha: "08753a1d793c040b101c8a26c43445dbbab14995",
            },
          },
          channel: {
            value: "dev",
          },
        }),
        { ref: "08753a1d793c040b101c8a26c43445dbbab14995" },
      ),
    ).toBeUndefined();
  });

  it("accepts uppercase requested commit shas when update status reports lowercase", () => {
    expect(
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "git",
            git: {
              sha: "08753a1d793c040b101c8a26c43445dbbab14995",
            },
          },
          channel: {
            value: "dev",
          },
        }),
        { ref: "08753A1D793C040B101C8A26C43445DBBAB14995" },
      ),
    ).toBeUndefined();
  });

  it("rejects update status payloads that are not on dev/main git", () => {
    expect(() =>
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "package",
            git: {
              branch: "release",
            },
          },
          channel: {
            value: "stable",
          },
        }),
      ),
    ).toThrow("git install");
  });
});
