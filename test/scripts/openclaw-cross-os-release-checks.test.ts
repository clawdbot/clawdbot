import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection as createNetConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";
import {
  agentOutputHasExpectedOkMarker,
  agentTurnUsedEmbeddedFallback,
  buildCrossOsReleaseSmokePluginAllowlist,
  buildDiscordFetchInit,
  buildPackagedUpgradeUpdateArgs,
  buildReleaseOnboardArgs,
  buildWindowsDevUpdateToolchainCheckScript,
  buildWindowsFreshShellVersionCheckScript,
  buildInstalledBrowserOverrideImportProbeScript,
  buildNpmGlobalInstallArgs,
  buildGatewayStatusArgsFromHelpText,
  buildWindowsPathBootstrapScript,
  canConnectToLoopbackPort,
  buildDiscordSmokeGuildsConfig,
  buildRealUpdateEnv,
  CROSS_OS_FETCH_BODY_MAX_CHARS,
  CROSS_OS_GATEWAY_READY_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
  CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE,
  CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS,
  CROSS_OS_WINDOWS_PACKAGED_UPGRADE_STEP_TIMEOUT_SECONDS,
  CROSS_OS_WINDOWS_PACKAGED_UPGRADE_WRAPPER_TIMEOUT_MS,
  CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS,
  CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS,
  CROSS_OS_DISCORD_FETCH_TIMEOUT_MS,
  CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  CROSS_OS_COMMAND_HEARTBEAT_SECONDS,
  isImmutableReleaseRef,
  isRecoverableWindowsPackagedUpgradeSwapCleanupFailure,
  isRecoverableWindowsPackagedUpgradeTimeoutError,
  looksLikeReleaseVersionRef,
  normalizeRequestedRef,
  normalizeWindowsCommandShimPath,
  normalizeWindowsInstalledCliPath,
  maybeBuildOptionalAgentTurnSkipResult,
  parsePositiveIntegerEnv,
  parseCrossOsSuiteFilter,
  parseArgs,
  packageHasScript,
  readInstalledVersion,
  readBoundedCrossOsResponseText,
  readRunnerOverrideEnv,
  resolveCrossOsAgentTurnOptional,
  runCommand,
  resolveCommandSpawnInvocation,
  resolveExplicitBaselineVersion,
  resolveInstalledCliInvocation,
  resolveInstalledPackageRootFromCliPath,
  resolveProviderConfig,
  resolveDevUpdateVerificationRef,
  resolveInstalledPrefixDirFromCliPath,
  resolvePublishedInstallerUrl,
  resolveRequestedSuites,
  resolveRunnerMatrix,
  resolveStaticFileContentType,
  startStaticFileServer,
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
  verifyWindowsPackagedUpgradeFallbackInstall,
  writePackageDistInventoryForCandidate,
} from "../../scripts/openclaw-cross-os-release-checks.ts";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`process still alive: ${pid}`);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ signal: NodeJS.Signals | null; status: number | null }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("timeout waiting for child exit")),
      timeoutMs,
    );
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ signal, status });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

describe("scripts/openclaw-cross-os-release-checks", () => {
  it("keeps dashboard smoke patient enough for cold packaged gateway startup", () => {
    expect(CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("bounds cross-OS fetched response bodies", async () => {
    const tail = "tail-sentinel-should-not-appear";
    const response = new Response(`${"x".repeat(5000)}${tail}`);

    const text = await readBoundedCrossOsResponseText(response, 128);

    expect(text).toContain("[truncated]");
    expect(text).not.toContain(tail);
    expect(CROSS_OS_FETCH_BODY_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("keeps gateway RPC status probes patient enough for live release startup", () => {
    expect(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS).toBeGreaterThan(
      CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
    );
    expect(CROSS_OS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    expect(CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it("keeps gateway status RPC probing when help probing is unavailable", () => {
    expect(buildGatewayStatusArgsFromHelpText("--require-rpc")).toEqual([
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ]);
    expect(buildGatewayStatusArgsFromHelpText("Usage: openclaw gateway status")).toEqual([
      "gateway",
      "status",
    ]);
    expect(
      buildGatewayStatusArgsFromHelpText("--require-rpc", {
        requireRpc: false,
      }),
    ).toEqual(["gateway", "status"]);
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

  it("rejects malformed cross-OS positive integer environment values", () => {
    expect(parsePositiveIntegerEnv("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS", 60, {})).toBe(60);
    expect(
      parsePositiveIntegerEnv("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS", 60, {
        OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS: "25",
      }),
    ).toBe(25);

    for (const raw of ["1e3", "25ms", "1.5", "0", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() =>
        parsePositiveIntegerEnv("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS", 60, {
          OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS: raw,
        }),
      ).toThrow("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS must be a positive integer");
    }
  });

  it("records packaged-fresh phase timings for release-check summaries", () => {
    const source = readFileSync("scripts/openclaw-cross-os-release-checks.ts", "utf8");
    const freshLaneSource = source.slice(
      source.indexOf("async function runFreshLane"),
      source.indexOf("async function runUpgradeLane"),
    );

    expect(freshLaneSource).toContain('runTimedLanePhase(lane, "install-candidate"');
    expect(freshLaneSource).toContain('runTimedLanePhase(lane, "agent-turn"');
    expect(freshLaneSource).toContain("phaseTimings: lane.phaseTimings");
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
    expect(
      shouldRetryCrossOsAgentTurnError(
        new Error("Agent turn used embedded fallback instead of gateway."),
      ),
    ).toBe(true);
  });

  it("requires explicit opt-in before cross-OS agent turns become optional", () => {
    expect(resolveCrossOsAgentTurnOptional({})).toBe(false);
    expect(resolveCrossOsAgentTurnOptional({ OPENCLAW_CROSS_OS_AGENT_TURN_OPTIONAL: "1" })).toBe(
      true,
    );
    expect(
      resolveCrossOsAgentTurnOptional({ OPENCLAW_CROSS_OS_AGENT_TURN_OPTIONAL: "false" }),
    ).toBe(false);
  });

  it("detects embedded fallback agent turns as non-gateway proof", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-agent-fallback-"));
    const logPath = join(dir, "agent.log");
    expect(
      agentTurnUsedEmbeddedFallback({
        stdout: JSON.stringify({ payloads: [{ text: "OK" }] }),
        stderr: "EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: gateway closed",
      }),
    ).toBe(true);
    expect(
      agentTurnUsedEmbeddedFallback({
        stdout: JSON.stringify({ payloads: [{ text: "OK" }] }),
        stderr: "",
      }),
    ).toBe(false);
    expect(
      agentTurnUsedEmbeddedFallback(
        { stdout: "", stderr: "" },
        { logText: 'EMBEDDED FALLBACK: Gateway agent failed\n{"payloads":[{"text":"OK"}]}' },
      ),
    ).toBe(true);
    try {
      writeFileSync(logPath, "EMBEDDED FALLBACK: Gateway agent failed\n");
      expect(agentTurnUsedEmbeddedFallback({ stdout: "", stderr: "" }, { logPath })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("only skips opted-in cross-OS live agent turns after retry exhaustion", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-agent-skip-retry-"));
    try {
      const logPath = join(dir, "agent.log");
      const error = new Error("gateway request timeout for agent after 210000ms");

      expect(
        maybeBuildOptionalAgentTurnSkipResult(error, logPath, {
          attempt: 1,
          maxAttempts: 2,
          optional: true,
        }),
      ).toBeNull();
      expect(
        maybeBuildOptionalAgentTurnSkipResult(error, logPath, {
          attempt: 2,
          maxAttempts: 2,
          optional: false,
        }),
      ).toBeNull();

      const skipped = maybeBuildOptionalAgentTurnSkipResult(error, logPath, {
        attempt: 2,
        maxAttempts: 2,
        optional: true,
      });

      expect(skipped?.status).toBe(0);
      expect(JSON.parse(skipped?.stdout ?? "{}")).toEqual({
        status: "skipped",
        reason: "cross-os live agent turn unavailable after retry",
      });
      expect(readFileSync(logPath, "utf8")).toContain(
        "skipping optional cross-OS live agent turn after retryable failure",
      );
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

  it("keeps the Windows packaged-upgrade fallback install out of npm lifecycle scripts", () => {
    const source = readFileSync("scripts/openclaw-cross-os-release-checks.ts", "utf8");
    const fallbackInstallSource = source.slice(
      source.indexOf('runTimedLanePhase(lane, "update-fallback-install"'),
      source.indexOf('runTimedLanePhase(lane, "update-status"'),
    );

    expect(fallbackInstallSource).toContain("ignoreScripts: true");
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
    expect(source).toContain('agentRuntime: { id: "openclaw" }');
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
      runner: "blacksmith-6vcpu-macos-15",
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

  it("streams release artifacts from the static file server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-static-server-"));
    const filePath = join(dir, "openclaw-2026.4.14.tgz");
    const logPath = join(dir, "server.log");
    let server: Awaited<ReturnType<typeof startStaticFileServer>> | undefined;

    try {
      const payload = Buffer.from(`artifact-head\n${"x".repeat(1024 * 1024)}\nartifact-tail`);
      writeFileSync(filePath, payload);

      server = await startStaticFileServer({ filePath, logPath });
      const response = await fetch(server.url);
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(payload.length));
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(body.equals(payload)).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain(`GET /${filePath.split(/[/\\]/u).at(-1)}`);
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes static release artifact sockets left by aborted clients", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-static-server-close-"));
    const filePath = join(dir, "openclaw-2026.4.14.tgz");
    const logPath = join(dir, "server.log");
    let server: Awaited<ReturnType<typeof startStaticFileServer>> | undefined;

    try {
      writeFileSync(filePath, Buffer.alloc(1024 * 1024, "x"));
      server = await startStaticFileServer({ filePath, logPath });
      const url = new URL(server.url);
      const socket = createNetConnection(Number(url.port), url.hostname);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
      await Promise.race([
        server.close(),
        delay(1_000).then(() => {
          throw new Error("close timed out");
        }),
      ]);
      await Promise.race([
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
        }),
        delay(1_000).then(() => {
          throw new Error("socket close timed out");
        }),
      ]);
    } finally {
      await server?.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not preload static release artifacts before serving them", () => {
    const source = readFileSync("scripts/openclaw-cross-os-release-checks.ts", "utf8");
    const serverSource = source.slice(
      source.indexOf("export async function startStaticFileServer"),
      source.indexOf("export function resolveStaticFileContentType"),
    );

    expect(serverSource).toContain("createReadStream(params.filePath)");
    expect(serverSource).not.toContain("readFileSync(params.filePath)");
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

  it("wraps Windows cmd shims without Node shell argv", () => {
    expect(
      resolveCommandSpawnInvocation(
        String.raw`C:\Program Files\nodejs\npm.cmd`,
        ["view", "openclaw@latest", "version"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          platform: "win32",
        },
      ),
    ).toEqual({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Program Files\nodejs\npm.cmd" view openclaw@latest version"`,
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("wraps installed Windows CLI cmd fallbacks without Node shell argv", () => {
    expect(
      resolveInstalledCliInvocation(
        win32.join(String.raw`C:\OpenClaw Prefix`, "openclaw.cmd"),
        ["gateway", "run", "--port", "1234"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          platform: "win32",
        },
      ),
    ).toEqual({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\OpenClaw Prefix\openclaw.cmd" gateway run --port 1234"`,
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("runs resolved command invocations and writes command logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-run-command-"));
    try {
      const logPath = join(dir, "command.log");
      const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
        cwd: dir,
        env: process.env,
        logPath,
      });

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });
      expect(readFileSync(logPath, "utf8")).toContain("start command=");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds retained command output while preserving full command logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-run-command-output-"));
    try {
      const logPath = join(dir, "command.log");
      const result = await runCommand(
        process.execPath,
        [
          "-e",
          [
            "process.stdout.write('old-middle-recent');",
            "process.stderr.write('err-old-err-recent');",
          ].join(""),
        ],
        {
          cwd: dir,
          env: process.env,
          logPath,
          maxOutputBytes: 12,
        },
      );

      expect(result.stdout).toBe("iddle-recent");
      expect(result.stderr).toBe("d-err-recent");
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("old-middle-recent");
      expect(log).toContain("err-old-err-recent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills timed-out command process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-run-command-timeout-"));
    const childPidPath = join(dir, "child.pid");
    try {
      const logPath = join(dir, "timeout.log");
      const childScript = "setInterval(() => {}, 1000);";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");

      const command = runCommand(process.execPath, ["-e", parentScript], {
        cwd: dir,
        env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
        logPath,
        timeoutMs: 500,
      });
      await waitForFile(childPidPath, 2_000);
      const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);

      await expect(command).rejects.toThrow(/Command timed out:/u);
      await waitForDead(childPid, 2_000);
      expect(readFileSync(logPath, "utf8")).toContain("timeout command=");
    } finally {
      const childPid = existsSync(childPidPath)
        ? Number.parseInt(readFileSync(childPidPath, "utf8"), 10)
        : 0;
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards external termination to command process groups", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "openclaw-cross-os-run-command-signal-"));
    const childPidPath = join(dir, "child.pid");
    const scriptUrl = pathToFileURL(
      resolvePath("scripts/openclaw-cross-os-release-checks.ts"),
    ).href;
    let childPid: number | undefined;
    let runnerPid: number | undefined;

    try {
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const runnerScript = [
        `import { runCommand } from ${JSON.stringify(scriptUrl)};`,
        `await runCommand(process.execPath, ['-e', ${JSON.stringify(parentScript)}], {`,
        `  cwd: ${JSON.stringify(dir)},`,
        `  env: process.env,`,
        `  logPath: ${JSON.stringify(join(dir, "signal.log"))},`,
        `  timeoutMs: 60000,`,
        `});`,
      ].join("\n");
      const runner = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", runnerScript],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_CROSS_OS_PROCESS_TREE_KILL_AFTER_MS: "25",
            OPENCLAW_TEST_CHILD_PID: childPidPath,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      runnerPid = runner.pid;

      await waitForFile(childPidPath, 2_000);
      childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
      runner.kill("SIGTERM");
      const result = await waitForExit(runner, 5_000);

      expect(result).toEqual({ signal: null, status: 143 });
      await waitForDead(childPid, 2_000);
    } finally {
      if (runnerPid !== undefined && isProcessAlive(runnerPid)) {
        process.kill(runnerPid, "SIGKILL");
      }
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("bounds Discord API calls with a timeout signal", () => {
    expect(CROSS_OS_DISCORD_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);

    const init = buildDiscordFetchInit("discord-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      headers: {
        Authorization: "Bot discord-token",
        "Content-Type": "application/json",
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
      OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
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

  it("verifies the Windows packaged-upgrade fallback installed the candidate", () => {
    expect(() =>
      verifyWindowsPackagedUpgradeFallbackInstall({
        installedVersion: "2026.5.4-beta.1",
        candidateVersion: "2026.5.4-beta.1",
      }),
    ).not.toThrow();
    expect(() =>
      verifyWindowsPackagedUpgradeFallbackInstall({
        installedVersion: "2026.5.3",
        candidateVersion: "2026.5.4-beta.1",
      }),
    ).toThrow(/expected 2026\.5\.4-beta\.1/u);
    expect(() =>
      verifyWindowsPackagedUpgradeFallbackInstall({
        installedVersion: "",
        candidateVersion: "2026.5.4-beta.1",
      }),
    ).toThrow(/installed unknown/u);
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
