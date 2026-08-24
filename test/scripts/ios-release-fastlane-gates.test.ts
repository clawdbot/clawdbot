// iOS Fastlane release gate tests keep TestFlight upload on one canonical path.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fastfilePath = path.join(process.cwd(), "apps", "ios", "fastlane", "Fastfile");
const packageJsonPath = path.join(process.cwd(), "package.json");
const legacyReleaseScriptPath = path.join(process.cwd(), "scripts", "ios-release.sh");
const uploadScriptPath = path.join(process.cwd(), "scripts", "ios-release-upload.sh");
const snapshotUITestPath = path.join(
  process.cwd(),
  "apps",
  "ios",
  "UITests",
  "OpenClawSnapshotUITests.swift",
);
const rootTabsPath = path.join(process.cwd(), "apps", "ios", "Sources", "RootTabs.swift");
const ciWorkflowPath = path.join(process.cwd(), ".github", "workflows", "ci.yml");
const rubyVersionPath = path.join(process.cwd(), "apps", "ios", ".ruby-version");
const gemfilePath = path.join(process.cwd(), "apps", "ios", "Gemfile");
const gemfileLockPath = path.join(process.cwd(), "apps", "ios", "Gemfile.lock");
const iosReadmePath = path.join(process.cwd(), "apps", "ios", "README.md");
const fastlaneSetupPath = path.join(process.cwd(), "apps", "ios", "fastlane", "SETUP.md");
const metadataReadmePath = path.join(
  process.cwd(),
  "apps",
  "ios",
  "fastlane",
  "metadata",
  "README.md",
);
const screenshotsScriptPath = path.join(process.cwd(), "scripts", "ios-screenshots.sh");

function runIosScreenshotsCommand(
  options: {
    bundleCheckExit?: number;
    bundleExit?: number;
    conflictingGemfile?: boolean;
  } = {},
) {
  const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-ios-fastlane-"));
  const tracePath = path.join(fixture, "trace.log");
  const writeExecutable = (name: string, body: string) => {
    const executable = path.join(fixture, name);
    writeFileSync(executable, `#!/usr/bin/env bash\n${body}\n`, "utf8");
    chmodSync(executable, 0o755);
  };
  writeExecutable(
    "bundle",
    '[[ "$BUNDLE_GEMFILE" == "$OPENCLAW_FASTLANE_EXPECTED_GEMFILE" ]] || exit 91\n' +
      '[[ "${1:-}" == "_2.6.9_" ]] || exit 92\n' +
      `[[ "\${2:-}" != "check" ]] || exit ${options.bundleCheckExit ?? 0}\n` +
      'printf "bundle:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n' +
      `exit ${options.bundleExit ?? 0}`,
  );
  writeExecutable("fastlane", 'printf "direct:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"');

  try {
    const result = spawnSync("bash", [screenshotsScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_GEMFILE: options.conflictingGemfile ? path.join(fixture, "Gemfile") : "",
        OPENCLAW_FASTLANE_EXPECTED_GEMFILE: gemfilePath,
        OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
        PATH: `${fixture}:/usr/bin:/bin`,
      },
    });
    return {
      result,
      trace: existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "",
    };
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

function readFastfile(): string {
  return readFileSync(fastfilePath, "utf8");
}

function laneBody(source: string, name: string): string {
  const startMarker = `lane :${name} do`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastlane lane ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextLane = rest.search(/\n\s+(?:desc|lane|private_lane) /);
  return nextLane < 0 ? rest : rest.slice(0, nextLane);
}

function functionBody(source: string, name: string): string {
  const startMarker = `def ${name}`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastfile function ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextFunction = rest.search(/\ndef /);
  return nextFunction < 0 ? rest : rest.slice(0, nextFunction);
}

function swiftFunctionBody(source: string, name: string): string {
  const startMarker = `func ${name}(`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Swift function ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextFunction = rest.search(/\n {4}(?:private )?func /);
  return nextFunction < 0 ? rest : rest.slice(0, nextFunction);
}

describe("iOS Fastlane release upload gates", () => {
  it("pins the CI Ruby and Fastlane toolchain", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const iosJobStart = workflow.indexOf("\n  ios-build:\n");
    const iosJobEnd = workflow.indexOf("\n  android:\n", iosJobStart);
    const iosJob = workflow.slice(iosJobStart, iosJobEnd);
    const gemfile = readFileSync(gemfilePath, "utf8");
    const lockfile = readFileSync(gemfileLockPath, "utf8");

    expect(readFileSync(rubyVersionPath, "utf8")).toBe("3.4.10\n");
    expect(gemfile).toContain('gem "fastlane", "2.236.1"');
    expect(gemfile).toContain('ruby "3.4.10"');
    expect(lockfile).toContain("fastlane (2.236.1)");
    expect(lockfile).toContain("arm64-darwin");
    expect(lockfile).toContain("x86_64-darwin");
    expect(lockfile).toContain("CHECKSUMS");
    expect(lockfile).toContain("RUBY VERSION\n   ruby 3.4.10");
    expect(lockfile).toContain("BUNDLED WITH\n   2.6.9");
    expect(iosJob).toContain('BUNDLE_DEPLOYMENT: "true"');
    expect(iosJob).toContain("BUNDLE_GEMFILE: ${{ github.workspace }}/apps/ios/Gemfile");
    expect(iosJob).toContain("ruby/setup-ruby@95ef2b042f9d7a56d8268cba8559e2842e2ad01b");
    expect(iosJob).toContain('ruby-version: "3.4.10"');
    expect(iosJob).toContain('bundler: "2.6.9"');
    expect(iosJob).toContain("bundler-cache: false");
    expect(iosJob).toContain("working-directory: apps/ios");
    expect(iosJob).toContain("bundle _2.6.9_ install --jobs 4 --retry 3");
    expect(iosJob).toContain("bundle _2.6.9_ check");
    expect(iosJob).toContain("bundle _2.6.9_ exec fastlane --version");
  });

  it("documents every iOS Fastlane command through the pinned bundle", () => {
    const documentedCommands = [iosReadmePath, fastlaneSetupPath, metadataReadmePath].flatMap(
      (documentationPath) =>
        readFileSync(documentationPath, "utf8")
          .split("\n")
          .filter((line) => /\bfastlane (?:ios [a-z_]+|spaceauth)\b/u.test(line)),
    );

    expect(documentedCommands).toHaveLength(7);
    for (const command of documentedCommands) {
      expect(command).toContain('BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane');
    }
  });

  it("documents a direct Fastlane command that rejects an inherited Gemfile", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-ios-fastlane-docs-"));
    const bundlePath = path.join(fixture, "bundle");
    const tracePath = path.join(fixture, "trace.log");
    writeFileSync(
      bundlePath,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$BUNDLE_GEMFILE" > "$OPENCLAW_FASTLANE_TEST_TRACE"\n',
      "utf8",
    );
    chmodSync(bundlePath, 0o755);

    try {
      const result = spawnSync(
        "bash",
        ["-c", 'BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane ios auth_check'],
        {
          cwd: path.join(process.cwd(), "apps", "ios"),
          encoding: "utf8",
          env: {
            ...process.env,
            BUNDLE_GEMFILE: path.join(fixture, "Gemfile"),
            OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
            PATH: `${fixture}:/usr/bin:/bin`,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(tracePath, "utf8")).toBe(`${gemfilePath}\n`);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("uses the repository bundle when Fastlane is also on PATH", () => {
    const { result, trace } = runIosScreenshotsCommand();

    expect(result.status).toBe(0);
    expect(trace).toBe("bundle:_2.6.9_ exec fastlane ios screenshots\n");
  });

  it("fails closed when the repository bundle fails", () => {
    const { result, trace } = runIosScreenshotsCommand({ bundleExit: 42 });

    expect(result.status).toBe(42);
    expect(trace).toBe("bundle:_2.6.9_ exec fastlane ios screenshots\n");
  });

  it("prints the pinned setup command when the repository bundle is unavailable", () => {
    const { result, trace } = runIosScreenshotsCommand({ bundleCheckExit: 1 });

    expect(result.status).toBe(1);
    expect(trace).toBe("");
    expect(result.stderr).toContain("Install Ruby 3.4.10");
    expect(result.stderr).toContain("gem install bundler -v 2.6.9");
    expect(result.stderr).toContain("bundle _2.6.9_ install");
  });

  it("ignores a conflicting inherited Gemfile on the pinned path", () => {
    const { result, trace } = runIosScreenshotsCommand({ conflictingGemfile: true });

    expect(result.status).toBe(0);
    expect(trace).toBe("bundle:_2.6.9_ exec fastlane ios screenshots\n");
  });

  it("fails closed when the repository Gemfile is absent", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-ios-fastlane-missing-gemfile-"));
    const wrapperPath = path.join(fixture, "scripts", "lib", "ios-fastlane.sh");
    const binDir = path.join(fixture, "bin");
    const tracePath = path.join(fixture, "trace.log");
    mkdirSync(path.dirname(wrapperPath), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    copyFileSync(path.join(process.cwd(), "scripts", "lib", "ios-fastlane.sh"), wrapperPath);
    const inheritedGemfile = path.join(fixture, "Gemfile");
    writeFileSync(inheritedGemfile, 'gem "fastlane"\n', "utf8");
    const fastlanePath = path.join(binDir, "fastlane");
    writeFileSync(
      fastlanePath,
      '#!/usr/bin/env bash\nprintf "direct:%s\\n" "$*" >> "$OPENCLAW_FASTLANE_TEST_TRACE"\n',
      "utf8",
    );
    chmodSync(fastlanePath, 0o755);

    try {
      const result = spawnSync(
        "bash",
        ["-c", `source "${wrapperPath}"; run_ios_fastlane ios screenshots`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BUNDLE_GEMFILE: inheritedGemfile,
            OPENCLAW_FASTLANE_TEST_TRACE: tracePath,
            PATH: `${binDir}:/usr/bin:/bin`,
          },
        },
      );

      expect(result.status).toBe(1);
      expect(existsSync(tracePath)).toBe(false);
      expect(result.stderr).toContain("repository iOS Gemfile is missing");
      expect(result.stderr).toContain("Restore it from the repository checkout");
      expect(result.stderr).toContain("bundle _2.6.9_ install");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("does not keep the old package release alias", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts).toHaveProperty("ios:release:upload");
    expect(packageJson.scripts).toHaveProperty("ios:release:plan");
    expect(packageJson.scripts).toHaveProperty("ios:release:cut");
    expect(packageJson.scripts).not.toHaveProperty("ios:release");
    expect(existsSync(legacyReleaseScriptPath)).toBe(false);
  });

  it("routes the package upload wrapper through the guarded Fastlane lane", () => {
    const script = readFileSync(uploadScriptPath, "utf8");

    expect(script).toContain("OPENCLAW_IOS_RELEASE_WRAPPER=1");
    expect(script).not.toContain("Missing required --version.");
    expect(script).not.toContain("Missing required --revision.");
    expect(script).toContain('"release_version:${RELEASE_VERSION}"');
    expect(script).toContain('"app_store_revision:${APP_STORE_REVISION}"');
    expect(script).toContain('"build_number:${BUILD_NUMBER}"');
    expect(script).toContain("DELIVER_NUMBER_OF_THREADS=1");
    expect(script).toContain("FL_MAX_NUMBER_OF_THREADS=1");
    expect(script).toContain('run_ios_fastlane "${FASTLANE_ARGS[@]}"');
  });

  it("keeps release_upload as the only Fastlane TestFlight upload implementation", () => {
    const fastfile = readFastfile();
    const uploadCalls = fastfile.match(/\bupload_to_testflight\s*\(/g) ?? [];

    expect(uploadCalls).toHaveLength(1);
    expect(laneBody(fastfile, "release_upload")).toContain("upload_to_testflight(");
    expect(fastfile).not.toMatch(/\n\s+lane :app_store do\b/);
    expect(fastfile).not.toContain("Deprecated. Use `pnpm ios:release:upload`.");
  });

  it("rejects direct Fastlane upload before release work", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const prepareContext = laneBody(fastfile, "prepare_app_store_context");

    expect(releaseUpload).toContain('ENV["OPENCLAW_IOS_RELEASE_WRAPPER"] == "1"');
    expect(releaseUpload).toContain("Use `pnpm ios:release:upload`");
    expect(prepareContext).toContain("options[:release_version]");
    expect(prepareContext).toContain("options[:app_store_revision]");
    expect(prepareContext).toContain("options[:build_number]");
    expect(prepareContext).toContain("resolve_ios_release_plan!");
    expect(prepareContext).toContain('release_plan.fetch("gatewayVersion")');
    expect(prepareContext).toContain('release_plan.fetch("appStoreRevision")');
    expect(prepareContext).toContain('release_plan.fetch("buildNumber")');
    expect(releaseUpload).toContain("app_store_revision: context[:app_store_revision]");
    expect(laneBody(fastfile, "metadata")).toContain("options[:release_version]");
    expect(laneBody(fastfile, "metadata")).toContain("Missing iOS gateway version");
    expect(laneBody(fastfile, "metadata")).toContain("Missing iOS App Store revision");
    expect(releaseUpload.indexOf("UI.user_error!")).toBeLessThan(
      releaseUpload.indexOf("prepare_app_store_context"),
    );
  });

  it("preflights the exact App Store version before screenshots and archive work", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const preflight = functionBody(fastfile, "preflight_app_store_version!");

    expect(preflight).toContain("EDITABLE_APP_STORE_VERSION_STATES");
    expect(preflight).toContain("RELEASED_APP_STORE_VERSION_STATES");
    expect(fastfile).toContain('"READY_FOR_SALE"');
    expect(fastfile).toContain('"REMOVED_FROM_SALE"');
    expect(fastfile).toContain('"DEVELOPER_REMOVED_FROM_SALE"');
    expect(fastfile).not.toMatch(
      /EDITABLE_APP_STORE_VERSION_STATES = \[[\s\S]*?"WAITING_FOR_REVIEW"[\s\S]*?\]\.freeze/,
    );
    expect(preflight).toContain("Revisions are never reused");
    expect(preflight).toContain("higher version");
    expect(releaseUpload).toContain("preflight_app_store_version!");
    expect(releaseUpload.indexOf("preflight_app_store_version!")).toBeLessThan(
      releaseUpload.indexOf("screenshots("),
    );
    expect(releaseUpload.indexOf("preflight_app_store_version!")).toBeLessThan(
      releaseUpload.indexOf("build = build_app_store_release(context)"),
    );
  });

  it("validates explicit build numbers against the exact App Store version", () => {
    const resolver = functionBody(readFastfile(), "resolve_release_build_number");

    expect(resolver).toContain("app_store_build_uploads");
    expect(resolver).toContain("IOS_BUILD_UPLOAD_STATES");
    expect(resolver).toContain("expected #{next_build}");
    expect(resolver).toContain("explicit.to_i != next_build");
    expect(resolver).toContain("api_key.nil?");
    expect(resolver).not.toContain("latest_testflight_build_number");
  });

  it("plans revisions and builds from App Store versions and build uploads", () => {
    const fastfile = readFastfile();
    const planner = functionBody(fastfile, "resolve_ios_release_plan!");
    const planLane = laneBody(fastfile, "release_plan");
    const uploadState = functionBody(fastfile, "app_store_build_upload_state");

    expect(planner).toContain("get_app_store_versions");
    expect(planner).toContain("app_store_build_uploads");
    expect(planner).toContain("app_store_build_upload_state(upload)");
    expect(uploadState).toContain('detail["state"]');
    expect(uploadState).toContain("expected a StateDetail object");
    expect(planner).toContain("does not match canonical root version");
    expect(planner).toContain('File.join(repo_root, "scripts", "ios-release-plan.ts")');
    expect(planLane).toContain("resolve_ios_release_plan!");
    expect(planLane).toContain("JSON.pretty_generate(plan)");
  });

  it("validates the exported IPA before the sole TestFlight upload call", () => {
    const fastfile = readFastfile();
    const validationCall = fastfile.indexOf("expected_commit: context[:git_commit]");
    const uploadCall = fastfile.indexOf("upload_to_testflight(");

    expect(validationCall).toBeGreaterThanOrEqual(0);
    expect(uploadCall).toBeGreaterThan(validationCall);
  });

  it("rechecks the plan after local validation and before the first App Store mutation", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const build = releaseUpload.indexOf("build = build_app_store_release(context)");
    const planRecheck = releaseUpload.lastIndexOf("resolve_ios_release_plan!");
    const metadata = releaseUpload.indexOf("\n    metadata(");
    const upload = releaseUpload.indexOf("upload_to_testflight(");

    expect(fastfile).not.toContain("def verify_app_store_binary!");
    expect(releaseUpload).not.toContain("verify_only: true");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(planRecheck).toBeGreaterThan(build);
    expect(metadata).toBeGreaterThan(planRecheck);
    expect(upload).toBeGreaterThan(planRecheck);
  });

  it("waits for Apple build processing without submitting to TestFlight review", () => {
    const releaseUpload = laneBody(readFastfile(), "release_upload");

    expect(releaseUpload).toContain("skip_waiting_for_build_processing: false");
    expect(releaseUpload).toContain("skip_submission: true");
    expect(releaseUpload).toContain(
      "wait_processing_timeout_duration: APP_STORE_BUILD_PROCESSING_TIMEOUT_SECONDS",
    );
    expect(releaseUpload).not.toContain("skip_waiting_for_build_processing: true");
  });

  it("finishes fallible local release work before mutating App Store metadata", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");
    const screenshots = releaseUpload.indexOf(
      "screenshots(\n          release_version: context[:version]",
    );
    const sourceCheck = releaseUpload.indexOf("verify_apple_release_source!(release_sha)");
    const build = releaseUpload.indexOf("build = build_app_store_release(context)");
    const metadata = releaseUpload.indexOf("metadata(\n      release_version: context[:version]");

    expect(screenshots).toBeGreaterThanOrEqual(0);
    expect(sourceCheck).toBeGreaterThan(screenshots);
    expect(build).toBeGreaterThan(sourceCheck);
    expect(metadata).toBeGreaterThan(build);
  });

  it("fails from authoritative Xcode results and keeps successful bundles outside screenshots", () => {
    const fastfile = readFastfile();
    const screenshots = laneBody(fastfile, "screenshots");
    const capture = functionBody(fastfile, "capture_release_ios_screenshot!");
    const archive = functionBody(fastfile, "archive_snapshot_test_result!");
    const verifier = functionBody(fastfile, "verify_snapshot_test_result!");

    expect(screenshots).toContain("devices = snapshot_devices");
    expect(screenshots).toContain("build_for_testing: true");
    expect(screenshots).toContain("RELEASE_IOS_SCREENSHOT_TESTS.each");
    expect(screenshots).toContain("capture_release_ios_screenshot!(");
    expect(capture).toContain("1.upto(2)");
    expect(screenshots).toContain(
      "result_bundle_archive_directory: result_bundle_archive_directory",
    );
    expect(capture).toContain(
      'only_testing: ["OpenClawUITests/OpenClawSnapshotUITests/#{test_name}"]',
    );
    expect(capture).toContain("test_without_building: true");
    expect(capture).toContain("result_bundle: true");
    expect(capture).toContain("number_of_retries: 0");
    expect(capture).toContain("stop_after_first_error: true");
    expect(capture).toContain("retrying once in a fresh simulator session");
    expect(capture).toContain("verify_snapshot_test_result!");
    expect(archive).toContain('"#{device}-#{screenshot_name}-attempt-#{attempt}.xcresult"');
    expect(screenshots).toContain("verify_release_ios_screenshot_manifest!(");
    expect(screenshots).toContain(
      'result_bundle_archive_directory = File.join(ios_root, "build", "SnapshotTestResults")',
    );
    expect(screenshots.indexOf("capture_release_ios_screenshot!")).toBeLessThan(
      screenshots.indexOf('FileUtils.rm_rf(File.join(output_directory, "test_output"))'),
    );
    expect(verifier).toContain('"xcresulttool"');
    expect(verifier).toContain('summary.fetch("failedTests")');
    expect(verifier).toContain("UI.test_failure!");
  });

  it("captures each release screen from an independent direct launch", () => {
    const snapshotUITest = readFileSync(snapshotUITestPath, "utf8");
    const releaseTests = [
      ["testReleaseControlScreenshot", "controlScreenshotTarget"],
      ["testReleaseChatScreenshot", "chatScreenshotTarget"],
      ["testReleaseAgentScreenshot", "agentScreenshotTarget"],
      ["testReleaseSettingsScreenshot", "settingsScreenshotTarget"],
    ] as const;
    const captureHelper = swiftFunctionBody(snapshotUITest, "captureReleaseScreenshot");
    const launchHelper = swiftFunctionBody(snapshotUITest, "launchApp");
    const navigationTest = swiftFunctionBody(
      snapshotUITest,
      "testAgentsNavigateToSettingsThroughSidebar",
    );
    const rootTabs = readFileSync(rootTabsPath, "utf8");

    for (const [testName, targetName] of releaseTests) {
      const releaseTest = swiftFunctionBody(snapshotUITest, testName);
      expect(releaseTest).toContain(`self.captureReleaseScreenshot(Self.${targetName})`);
    }
    expect(captureHelper.match(/self\.launchApp\(/g)).toHaveLength(1);
    expect(captureHelper).toContain("waitForReleaseScreenshotTarget");
    expect(launchHelper).toContain("app.launch()");
    expect(snapshotUITest).not.toContain("screenshotLaunchRetryThreshold");
    expect(snapshotUITest).not.toContain("selectReleaseScreenshotDestination");
    expect(navigationTest).toContain("self.launchApp(for: Self.agentScreenshotTarget)");
    expect(navigationTest).toContain('self.selectSidebarDestination("Settings")');
    expect(navigationTest).toContain('"settings-system-agent-row"');
    expect(navigationTest).not.toContain("XCTExpectFailure");
    expect(navigationTest).not.toContain("XCTExpectedFailure");
    expect(rootTabs).toContain("self.scenePhase == .active");
    expect(rootTabs).toContain("self.selectedSidebarDestination.rawValue");
  });

  it("requires the exact nonempty PNG manifest before Watch capture", () => {
    const fastfile = readFastfile();
    const screenshots = laneBody(fastfile, "screenshots");
    const verifier = functionBody(fastfile, "verify_release_ios_screenshot_manifest!");

    expect(fastfile).toContain("REQUIRED_IOS_SCREENSHOT_NAMES");
    expect(verifier).toContain("expected_names - actual_names");
    expect(verifier).toContain("actual_names - expected_names");
    expect(verifier).toContain("File.size?(path)");
    expect(verifier).toContain("PNG_SIGNATURE");
    expect(screenshots.indexOf("verify_release_ios_screenshot_manifest!")).toBeGreaterThan(
      screenshots.indexOf("RELEASE_IOS_SCREENSHOT_TESTS.each"),
    );
    expect(screenshots.indexOf("verify_release_ios_screenshot_manifest!")).toBeLessThan(
      screenshots.indexOf("watch_screenshot("),
    );
  });

  it("runs the exact screenshot lane during native Apple, manual, and full release CI", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const iosJobStart = workflow.indexOf("\n  ios-build:\n");
    const iosJobEnd = workflow.indexOf("\n  android:\n", iosJobStart);
    const iosJob = workflow.slice(iosJobStart, iosJobEnd);

    expect(iosJob).toContain("timeout-minutes: 150");
    expect(iosJob).toContain("Capture iOS release screenshots");
    expect(iosJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(iosJob).toContain("github.event_name == 'pull_request'");
    expect(iosJob).toContain("inputs.release_gate");
    expect(iosJob).toContain("needs.preflight.outputs.run_ios_screenshots == 'true'");
    expect(iosJob).not.toContain("needs.preflight.outputs.run_macos == 'true'");
    expect(iosJob).toContain("run: pnpm ios:screenshots");
    expect(iosJob).toContain("Upload iOS release screenshot evidence");
    expect(iosJob).toContain("apps/ios/build/SnapshotTestResults/*.xcresult");
    expect(iosJob).toContain("if-no-files-found: error");
  });

  it("preserves caller-pinned Swift tools in archive build PATH", () => {
    const fastfile = readFastfile();
    const pathBuilder = functionBody(fastfile, "xcodebuild_shell_join");
    const callerPath = 'ENV.fetch("PATH", "").split(File::PATH_SEPARATOR)';

    expect(pathBuilder).toContain(callerPath);
    expect(pathBuilder).toContain(".reject(&:empty?).uniq.join(File::PATH_SEPARATOR)");
    expect(pathBuilder).toContain(
      "system_tools_first ? [*system_path, *caller_path] : [*caller_path, *system_path]",
    );
  });

  it("uses Apple's matched rsync pair when exporting the IPA", () => {
    const fastfile = readFastfile();
    const builder = functionBody(fastfile, "build_app_store_release");
    const exportStart = builder.indexOf('"-exportArchive"');

    expect(exportStart).toBeGreaterThanOrEqual(0);
    expect(builder.slice(exportStart)).toContain("system_tools_first: true");
  });

  it("requires clean matching source before preparing and building release artifacts", () => {
    const fastfile = readFastfile();
    const verifier = functionBody(fastfile, "verify_apple_release_source!");
    const provenance = functionBody(fastfile, "pin_release_build_provenance!");
    const builder = functionBody(fastfile, "build_app_store_release");

    expect(verifier).toContain('"apple-release-source-check.sh"');
    expect(verifier).toContain('"--root"');
    expect(verifier).toContain('"--expected-commit"');
    expect(provenance).toContain("verify_apple_release_source!(normalized_commit)");
    expect(provenance).not.toContain('ENV["GITHUB_SHA"]');
    expect(builder).toContain("verify_apple_release_source!(context[:git_commit])");
    expect(builder.indexOf("verify_apple_release_source!")).toBeLessThan(
      builder.indexOf("FileUtils.mkdir_p(output_directory)"),
    );
  });

  it("preflights and records mobile release refs around TestFlight upload", () => {
    const fastfile = readFastfile();
    const releaseUpload = laneBody(fastfile, "release_upload");

    expect(fastfile).toContain("def mobile_release_ref_command");
    expect(fastfile).toContain("def release_git_sha");
    expect(fastfile).toContain('"--root"');
    expect(fastfile).toContain('"--sha"');
    expect(fastfile).toContain("repo_root");
    expect(fastfile).toContain("def pin_release_build_provenance!");
    expect(laneBody(fastfile, "prepare_app_store_context")).toContain(
      "provenance = pin_release_build_provenance!",
    );
    expect(releaseUpload).toContain("release_sha = context[:git_commit]");
    expect(releaseUpload).toContain("ensure_mobile_release_ref_available!");
    expect(releaseUpload).toContain("record_mobile_release_ref!");
    expect(releaseUpload).toContain("screenshots(\n          release_version: context[:version]");
    expect(fastfile).toContain("def without_xcode_xcconfig_file");
    expect(releaseUpload).toContain("without_xcode_xcconfig_file do");
    expect(releaseUpload.match(/sha: release_sha/g)).toHaveLength(2);
    expect(releaseUpload.indexOf("prepare_app_store_context")).toBeLessThan(
      releaseUpload.indexOf("screenshots(\n          release_version: context[:version]"),
    );
    expect(releaseUpload.indexOf("ensure_mobile_release_ref_available!")).toBeLessThan(
      releaseUpload.indexOf("screenshots(\n          release_version: context[:version]"),
    );
    expect(releaseUpload.indexOf("ensure_mobile_release_ref_available!")).toBeLessThan(
      releaseUpload.indexOf("\n    metadata(\n      release_version: context[:version]"),
    );
    expect(releaseUpload.indexOf("record_mobile_release_ref!")).toBeGreaterThan(
      releaseUpload.indexOf("upload_to_testflight("),
    );
  });

  it("normalizes Watch screenshots as opaque RGB PNGs for App Store upload", () => {
    const fastfile = readFastfile();

    expect(laneBody(fastfile, "screenshots")).toContain(
      'File.join(repo_root, "scripts", "ios-write-version-xcconfig.sh"), *version_args',
    );
    expect(laneBody(fastfile, "watch_screenshot")).toContain(
      'File.join(repo_root, "scripts", "ios-write-version-xcconfig.sh"), *version_args',
    );
    expect(fastfile).toContain("def normalize_watch_screenshot_status_bar(path)");
    expect(fastfile).toContain("CGImageAlphaInfo.noneSkipLast.rawValue");
    expect(fastfile).toContain("CGImageDestinationCreateWithURL");
    expect(fastfile).toContain("operation: .sourceOver");
  });
});
