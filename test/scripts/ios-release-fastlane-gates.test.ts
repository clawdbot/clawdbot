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
const iosAgentsPath = path.join(process.cwd(), "apps", "ios", "AGENTS.md");
const iosVersioningPath = path.join(process.cwd(), "apps", "ios", "VERSIONING.md");
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

function functionDefinition(source: string, name: string): string {
  const start = source.indexOf(`def ${name}`);
  if (start < 0) {
    throw new Error(`missing Fastfile function ${name}`);
  }
  const rest = source.slice(start);
  const nextFunction = rest.slice(1).search(/\ndef /);
  return nextFunction < 0 ? rest : rest.slice(0, nextFunction + 1);
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
  it("pins the CI Ruby and Fastlane toolchain on the Fastlane-owning screenshot shards", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const iosJobStart = workflow.indexOf("\n  ios-build:\n");
    const iosJobEnd = workflow.indexOf("\n  ios-screenshot-shard:\n", iosJobStart);
    const iosJob = workflow.slice(iosJobStart, iosJobEnd);
    const shardJobEnd = workflow.indexOf("\n  ios-screenshot-evidence:\n", iosJobEnd);
    const shardJob = workflow.slice(iosJobEnd, shardJobEnd);
    const gemfile = readFileSync(gemfilePath, "utf8");
    const lockfile = readFileSync(gemfileLockPath, "utf8");

    expect(readFileSync(rubyVersionPath, "utf8")).toBe("3.4.10\n");
    expect(gemfile).toContain('gem "fastlane", "2.238.0"');
    expect(gemfile).toContain('ruby "3.4.10"');
    expect(lockfile).toContain("fastlane (2.238.0)");
    expect(lockfile).toContain("arm64-darwin");
    expect(lockfile).toContain("x86_64-darwin");
    expect(lockfile).toContain("CHECKSUMS");
    expect(lockfile).toContain("RUBY VERSION\n   ruby 3.4.10");
    expect(lockfile).toContain("BUNDLED WITH\n   2.6.9");
    expect(iosJob).not.toContain("BUNDLE_DEPLOYMENT");
    expect(iosJob).not.toContain("BUNDLE_GEMFILE");
    expect(iosJob).not.toContain("ruby/setup-ruby@");
    expect(iosJob).not.toContain("Install locked Fastlane bundle");
    expect(shardJob).toContain('BUNDLE_DEPLOYMENT: "true"');
    expect(shardJob).toContain("BUNDLE_GEMFILE: ${{ github.workspace }}/apps/ios/Gemfile");
    expect(shardJob).toContain("ruby/setup-ruby@95ef2b042f9d7a56d8268cba8559e2842e2ad01b");
    expect(shardJob).toContain('ruby-version: "3.4.10"');
    expect(shardJob).toContain('bundler: "2.6.9"');
    expect(shardJob).toContain("bundler-cache: false");
    expect(shardJob).toContain("working-directory: apps/ios");
    expect(shardJob).toContain("bundle _2.6.9_ install --jobs 4 --retry 3");
    expect(shardJob).toContain("bundle _2.6.9_ check");
    expect(shardJob).toContain("bundle _2.6.9_ exec fastlane --version");
    expect(workflow.match(/ruby\/setup-ruby@/gu)).toHaveLength(1);
    expect(workflow.match(/name: Install locked Fastlane bundle/gu)).toHaveLength(1);
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

  it("documents the shared mobile cutter as the sole release-note writer", () => {
    const operatorSurfaces = [
      iosAgentsPath,
      iosReadmePath,
      iosVersioningPath,
      fastlaneSetupPath,
      metadataReadmePath,
    ];

    for (const documentationPath of operatorSurfaces) {
      const documentation = readFileSync(documentationPath, "utf8");
      expect(documentation).not.toContain("pnpm ios:release:cut");
      expect(documentation).toContain("scripts/mobile-release-version.ts");
    }
    expect(readFastfile()).not.toContain("pnpm ios:release:cut");
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

  it("gates iOS uploads on committed shared mobile release state", () => {
    const fastfile = readFastfile();
    const checker = functionBody(fastfile, "check_mobile_release_versioning!");
    const prepareContext = laneBody(fastfile, "prepare_app_store_context");
    const plan = prepareContext.indexOf("resolve_ios_release_plan!");
    const gate = prepareContext.indexOf("check_mobile_release_versioning!");
    const sync = prepareContext.indexOf("sync_ios_versioning!");

    expect(checker).toContain('"android-sync-versioning.ts"');
    expect(checker).toContain('"--check"');
    expect(checker).toContain('"--require-mobile-release"');
    expect(checker).toContain('"--revision"');
    expect(checker).toContain("app_store_revision");
    expect(checker).toContain('"--root"');
    expect(prepareContext).toContain(
      "check_mobile_release_versioning!(app_store_revision: app_store_revision)",
    );
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(plan);
    expect(sync).toBeGreaterThan(gate);
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
    expect(planner).toContain("does not match canonical mobile version");
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

  it("keeps local upload-only behavior but requires explicit internal distribution in CI", () => {
    const releaseUpload = laneBody(readFastfile(), "release_upload");
    const intentContext = functionBody(readFastfile(), "mobile_release_intent_context!");

    expect(releaseUpload).toContain(
      "intent_context = mobile_release_intent_context!(gateway_version: context[:version])",
    );
    expect(releaseUpload).toContain(
      "internal_group_id = intent_context ? resolve_ci_testflight_internal_group_id! : nil",
    );
    expect(releaseUpload).toContain("skip_waiting_for_build_processing: false");
    expect(releaseUpload).toContain("upload_options[:skip_submission] = true");
    expect(releaseUpload).toContain("skip_submission: false");
    expect(releaseUpload).toContain("submit_beta_review: false");
    expect(releaseUpload).toContain("distribute_external: false");
    expect(releaseUpload).not.toContain("groups:");
    expect(releaseUpload).toContain(
      "wait_processing_timeout_duration: APP_STORE_BUILD_PROCESSING_TIMEOUT_SECONDS",
    );
    expect(releaseUpload).not.toContain("skip_waiting_for_build_processing: true");
    expect(releaseUpload.indexOf("mobile_release_intent_context!")).toBeLessThan(
      releaseUpload.indexOf("upload_to_testflight(**upload_options)"),
    );
    expect(releaseUpload.indexOf("resolve_ci_testflight_internal_group_id!")).toBeLessThan(
      releaseUpload.indexOf("upload_to_testflight(**upload_options)"),
    );
    expect(
      releaseUpload.indexOf("assign_and_verify_ci_testflight_internal_group!"),
    ).toBeGreaterThan(releaseUpload.indexOf("upload_to_testflight(**upload_options)"));
    expect(releaseUpload.indexOf("finalize_mobile_release_ref!")).toBeGreaterThan(
      releaseUpload.indexOf("assign_and_verify_ci_testflight_internal_group!"),
    );
    expect(intentContext).toContain("OPENCLAW_MOBILE_RELEASE_INTENT_PATH");
    expect(intentContext).toContain("OPENCLAW_MOBILE_RELEASE_AUTHORITY_RECEIPT_DIGEST");
    expect(intentContext).toContain("OPENCLAW_MOBILE_RELEASE_TARGET_REF");
  });

  it("requires one immutable internal TestFlight group ID without name collisions", () => {
    const configured = functionDefinition(
      readFastfile(),
      "configured_ci_testflight_internal_group_id!",
    );
    const selector = functionDefinition(
      readFastfile(),
      "select_ci_testflight_internal_group_by_id!",
    );
    const source = `
module UI
  def self.user_error!(message)
    raise message
  end
end
Group = Struct.new(:id, :name, :is_internal_group, :has_access_to_all_builds)
${configured}
${selector}
base_groups = [
  Group.new("internal-id", "Internal", true, false),
  Group.new("external-id", "External", false, false)
]
cases = [
  ["blank", "   ", base_groups],
  ["name-only", "Internal", base_groups],
  ["unknown", "missing-id", base_groups],
  ["external", "external-id", base_groups],
  [
    "collision",
    "internal-id",
    base_groups + [Group.new("other-id", "internal-id", true, false)]
  ],
  [
    "automatic-other",
    "internal-id",
    base_groups + [Group.new("automatic-id", "Automatic", true, true)]
  ],
  [
    "unknown-internal",
    "internal-id",
    base_groups + [Group.new("unknown-id", "Unknown Internal", true, nil)]
  ],
  [
    "unknown-external",
    "internal-id",
    [
      Group.new("internal-id", "Internal", true, false),
      Group.new("external-id", "External", false, nil)
    ]
  ],
  [
    "automatic-target",
    "internal-id",
    [
      Group.new("internal-id", "Internal", true, true),
      Group.new("external-id", "External", false, false)
    ]
  ],
  ["valid", "internal-id", base_groups]
]
cases.each do |label, configured_id, groups|
  ENV["TESTFLIGHT_INTERNAL_GROUP"] = configured_id
  begin
    group_id = configured_ci_testflight_internal_group_id!
    group = select_ci_testflight_internal_group_by_id!(groups: groups, group_id: group_id)
    puts "#{label}:ok:#{group.id}"
  rescue => error
    puts "#{label}:error:#{error.message}"
  end
end
`;
    const result = spawnSync("ruby", ["-e", source], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "blank:error:TESTFLIGHT_INTERNAL_GROUP must be a nonblank App Store Connect beta-group ID.",
      "name-only:error:TESTFLIGHT_INTERNAL_GROUP must match exactly one App Store Connect beta-group ID.",
      "unknown:error:TESTFLIGHT_INTERNAL_GROUP must match exactly one App Store Connect beta-group ID.",
      "external:error:The configured TestFlight beta group must be internal.",
      "collision:error:TESTFLIGHT_INTERNAL_GROUP collides with another TestFlight group name.",
      "automatic-other:error:Every non-target internal TestFlight group must explicitly disable automatic all-build access.",
      "unknown-internal:error:Every non-target internal TestFlight group must explicitly disable automatic all-build access.",
      "unknown-external:ok:internal-id",
      "automatic-target:ok:internal-id",
      "valid:ok:internal-id",
    ]);
  });

  it("freshly resolves and directly assigns the exact internal group to the uploaded build", () => {
    const selector = functionDefinition(
      readFastfile(),
      "select_ci_testflight_internal_group_by_id!",
    );
    const verifier = functionDefinition(
      readFastfile(),
      "assign_and_verify_ci_testflight_internal_group!",
    );
    const source = `
module UI
  def self.user_error!(message)
    raise message
  end
end
Group = Struct.new(:id, :name, :is_internal_group, :has_access_to_all_builds, :builds) do
  def fetch_builds
    builds
  end
end
module Spaceship
  class ConnectAPI
    module Platform
      IOS = "IOS"
    end
  end
end
Build = Struct.new(:id, :app_version, :version, :platform, :assigned_group_ids, :persist_assignment) do
  def add_beta_groups(beta_groups:)
    assigned_group_ids.concat(beta_groups.map(&:id))
    beta_groups.each { |group| group.builds << self } if persist_assignment
  end
end
App = Struct.new(:groups, :builds) do
  def get_beta_groups
    groups
  end

  def get_builds(filter:, includes:)
    builds
  end
end
def env_present?(value)
  !value.nil? && !value.strip.empty?
end
def resolve_app_store_connect_app(app_identifier:, app_id:)
  $fresh_app
end
${selector}
${verifier}

def run_case(label, post_groups:, app_builds:)
  pre_group = Group.new("group-id", "Pre-upload Internal", true, false, [])
  select_ci_testflight_internal_group_by_id!(groups: [pre_group], group_id: "group-id")
  $fresh_app = App.new(post_groups, app_builds)
  begin
    result = assign_and_verify_ci_testflight_internal_group!(
      group_id: "group-id",
      app_store_version: "2026.9.20",
      build_number: "8"
    )
    build = app_builds.first
    relationship_ids = result.fetch(:group).fetch_builds.map(&:id)
    puts "#{label}:ok:#{result.fetch(:group).name}:#{build.assigned_group_ids.join(",")}:#{relationship_ids.join(",")}"
  rescue => error
    puts "#{label}:error:#{error.message}"
  end
end

uploaded = Build.new("build-id", "2026.9.20", "8", "IOS", [], true)
run_case(
  "valid",
  post_groups: [Group.new("group-id", "Fresh Internal", true, false, [])],
  app_builds: [uploaded]
)
run_case(
  "missing-build",
  post_groups: [Group.new("group-id", "Fresh Internal", true, false, [])],
  app_builds: []
)
run_case(
  "wrong-platform",
  post_groups: [Group.new("group-id", "Fresh Internal", true, false, [])],
  app_builds: [Build.new("build-id", "2026.9.20", "8", "MAC_OS", [], true)]
)
run_case(
  "duplicate-builds",
  post_groups: [Group.new("group-id", "Fresh Internal", true, false, [])],
  app_builds: [
    Build.new("build-id-1", "2026.9.20", "8", "IOS", [], true),
    Build.new("build-id-2", "2026.9.20", "8", "IOS", [], true)
  ]
)
run_case(
  "missing-assignment",
  post_groups: [Group.new("group-id", "Fresh Internal", true, false, [])],
  app_builds: [Build.new("build-id", "2026.9.20", "8", "IOS", [], false)]
)
run_case(
  "post-upload-external",
  post_groups: [Group.new("group-id", "Fresh External", false, false, [])],
  app_builds: [Build.new("build-id", "2026.9.20", "8", "IOS", [], true)]
)
run_case(
  "post-upload-automatic-other",
  post_groups: [
    Group.new("group-id", "Fresh Internal", true, false, []),
    Group.new("automatic-id", "Automatic", true, true, [])
  ],
  app_builds: [Build.new("build-id", "2026.9.20", "8", "IOS", [], true)]
)
unexpected = Build.new("build-id", "2026.9.20", "8", "IOS", [], true)
run_case(
  "unexpected-assignment",
  post_groups: [
    Group.new("group-id", "Fresh Internal", true, false, []),
    Group.new("other-id", "Other Internal", true, false, [unexpected])
  ],
  app_builds: [unexpected]
)
`;
    const result = spawnSync("ruby", ["-e", source], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "valid:ok:Fresh Internal:group-id:build-id",
      "missing-build:error:Uploaded TestFlight build could not be resolved after processing.",
      "wrong-platform:error:Uploaded TestFlight build could not be resolved after processing.",
      "duplicate-builds:error:Uploaded TestFlight build could not be resolved after processing.",
      "missing-assignment:error:Uploaded TestFlight build is not assigned to the configured internal group.",
      "post-upload-external:error:The configured TestFlight beta group must be internal.",
      "post-upload-automatic-other:error:Every non-target internal TestFlight group must explicitly disable automatic all-build access.",
      "unexpected-assignment:error:Uploaded TestFlight build is assigned outside the configured internal group.",
    ]);
  });

  it("validates the complete iOS intent context before store mutation", () => {
    const intentContext = functionDefinition(readFastfile(), "mobile_release_intent_context!");
    const source = `
module UI
  def self.user_error!(message)
    raise message
  end
end
${intentContext}
cases = [
  {},
  { "OPENCLAW_MOBILE_RELEASE_REF_MODE" => "invalid" },
  { "OPENCLAW_MOBILE_RELEASE_REF_MODE" => "intent" },
  {
    "OPENCLAW_MOBILE_RELEASE_REF_MODE" => "intent",
    "OPENCLAW_MOBILE_RELEASE_INTENT_PATH" => "/tmp/intent.json",
    "OPENCLAW_MOBILE_RELEASE_AUTHORITY_RECEIPT_DIGEST" => "sha256:receipt",
    "OPENCLAW_MOBILE_RELEASE_TARGET_REF" => "release/2026.9.2-mobile"
  },
  {
    "OPENCLAW_MOBILE_RELEASE_REF_MODE" => "intent",
    "OPENCLAW_MOBILE_RELEASE_INTENT_PATH" => "/tmp/intent.json",
    "OPENCLAW_MOBILE_RELEASE_AUTHORITY_RECEIPT_DIGEST" => "sha256:#{"a" * 64}",
    "OPENCLAW_MOBILE_RELEASE_TARGET_REF" => "release/2026.9.3-mobile"
  },
  {
    "OPENCLAW_MOBILE_RELEASE_REF_MODE" => "intent",
    "OPENCLAW_MOBILE_RELEASE_INTENT_PATH" => "/tmp/intent.json",
    "OPENCLAW_MOBILE_RELEASE_AUTHORITY_RECEIPT_DIGEST" => "sha256:#{"a" * 64}",
    "OPENCLAW_MOBILE_RELEASE_TARGET_REF" => "release/2026.9.2-mobile"
  }
]
cases.each do |values|
  ENV.delete("OPENCLAW_MOBILE_RELEASE_REF_MODE")
  ENV.delete("OPENCLAW_MOBILE_RELEASE_INTENT_PATH")
  ENV.delete("OPENCLAW_MOBILE_RELEASE_AUTHORITY_RECEIPT_DIGEST")
  ENV.delete("OPENCLAW_MOBILE_RELEASE_TARGET_REF")
  values.each { |key, value| ENV[key] = value }
  begin
    context = mobile_release_intent_context!(gateway_version: "2026.9.2")
    puts context ? "ok:#{context.fetch(:target_ref)}" : "ok:local"
  rescue => error
    puts "error:#{error.message}"
  end
end
`;
    const result = spawnSync("ruby", ["-e", source], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "ok:local",
      "error:OPENCLAW_MOBILE_RELEASE_REF_MODE must be empty or intent.",
      "error:OPENCLAW_MOBILE_RELEASE_INTENT_PATH is required in intent mode.",
      "error:OPENCLAW_MOBILE_RELEASE_AUTHORITY_RECEIPT_DIGEST must be a canonical SHA-256 digest.",
      "error:OPENCLAW_MOBILE_RELEASE_TARGET_REF must exactly match the mobile gateway version.",
      "ok:release/2026.9.2-mobile",
    ]);
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
    const attemptRecorder = functionBody(fastfile, "record_release_ios_screenshot_attempt!");
    const attemptWriter = functionBody(fastfile, "write_release_ios_screenshot_attempts!");
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
    expect(capture).toContain('capture_outcome: "failed"');
    expect(capture).toContain('capture_outcome: "succeeded"');
    expect(capture.indexOf('capture_outcome: "failed"')).toBeLessThan(
      capture.indexOf("raise if attempt == 2"),
    );
    expect(attemptRecorder).toContain('"captureOutcome" => capture_outcome');
    expect(attemptRecorder).toContain("write_release_ios_screenshot_attempts!(");
    expect(attemptWriter).toContain('"schemaVersion" => 1');
    expect(archive).toContain('"#{device}-#{screenshot_name}-attempt-#{attempt}.xcresult"');
    expect(screenshots).toContain("verify_release_ios_screenshot_manifest!(");
    expect(screenshots).toContain(
      'result_bundle_archive_directory = File.join(ios_root, "build", "SnapshotTestResults")',
    );
    expect(screenshots).toContain(
      'capture_attempts_path = File.join(result_bundle_archive_directory, "capture-attempts.json")',
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
    const snapshotDevices = functionBody(fastfile, "snapshot_devices");
    const defaultSnapshotDevices = functionBody(fastfile, "default_snapshot_devices");
    const verifier = functionBody(fastfile, "verify_release_ios_screenshot_manifest!");

    expect(fastfile).toContain("REQUIRED_IOS_SCREENSHOT_NAMES");
    expect(snapshotDevices).toContain('ENV["OPENCLAW_SNAPSHOT_DEVICES"]');
    expect(snapshotDevices).toContain("return default_snapshot_devices if raw.empty?");
    expect(defaultSnapshotDevices).toContain("available_simulator_devices");
    expect(defaultSnapshotDevices).toContain('ENV["OPENCLAW_SNAPSHOT_DEVICE_FAMILY"]');
    expect(defaultSnapshotDevices).toContain("families = DEFAULT_SNAPSHOT_DEVICE_FAMILIES");
    expect(defaultSnapshotDevices).toContain("families = [family]");
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
    expect(screenshots).toContain('ENV["OPENCLAW_SNAPSHOT_SKIP_WATCH"] == "1"');
  });

  it("runs screenshot shards alongside builds without changing runner authorization", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const iosJobStart = workflow.indexOf("\n  ios-build:\n");
    const iosJobEnd = workflow.indexOf("\n  ios-screenshot-shard:\n", iosJobStart);
    const iosJob = workflow.slice(iosJobStart, iosJobEnd);
    const shardJobStart = iosJobEnd;
    const shardJobEnd = workflow.indexOf("\n  ios-screenshot-evidence:\n", shardJobStart);
    const shardJob = workflow.slice(shardJobStart, shardJobEnd);
    const reducerJobStart = shardJobEnd;
    const reducerJobEnd = workflow.indexOf("\n  android:\n", reducerJobStart);
    const reducerJob = workflow.slice(reducerJobStart, reducerJobEnd);

    expect(workflow).toContain('IOS_SCREENSHOT_NODE_VERSION: "24.16.0"');
    expect(workflow).toContain('IOS_SCREENSHOT_XCODE_VERSION: "Xcode 26.6 Build version 17F113"');
    expect(iosJob).toContain("timeout-minutes: 150");
    expect(iosJob).not.toContain("Capture iOS release screenshots");
    expect(shardJob).toContain("needs: [preflight]");
    expect(shardJob).toContain("max-parallel: 2");
    expect(shardJob).toContain("device_family: [iphone, ipad-13]");
    expect(shardJob).toContain('OPENCLAW_SNAPSHOT_SKIP_WATCH: "1"');
    expect(shardJob).toContain("if: matrix.device_family == 'ipad-13'");
    expect(shardJob).toContain("run_ios_fastlane ios watch_screenshot");
    expect(shardJob).toContain("run: pnpm ios:screenshots");
    expect(shardJob).toContain("id: package_screenshot_evidence");
    expect(shardJob).toContain("steps.package_screenshot_evidence.outcome == 'failure'");
    expect(shardJob).toContain("apps/ios/build/SnapshotTestResults/capture-attempts.json");
    expect(shardJob).not.toContain("IOS_SCREENSHOT_FASTLANE_VERSION");
    expect(shardJob).toContain("IOS_SCREENSHOT_NODE_VERSION");
    expect(shardJob).toContain("IOS_SCREENSHOT_XCODE_VERSION");
    expect(shardJob).not.toContain('test "$fastlane_version" = "$IOS_SCREENSHOT_FASTLANE_VERSION"');
    expect(shardJob).toContain("node-version: ${{ env.IOS_SCREENSHOT_NODE_VERSION }}");
    expect(shardJob).not.toContain("SnapshotDerivedData");
    expect(shardJob.match(/contents: read/g)).toHaveLength(1);
    expect(reducerJob).toContain("needs: [preflight, ios-screenshot-shard]");
    expect(reducerJob).toContain("merge-multiple: false");
    expect(reducerJob).toContain("Setup screenshot evidence Node");
    expect(reducerJob).toContain("node-version: ${{ env.IOS_SCREENSHOT_NODE_VERSION }}");
    expect(reducerJob).toContain("id: reduce_screenshot_evidence");
    expect(reducerJob).toContain("scripts/ios-screenshot-evidence.mjs reduce");
    expect(reducerJob).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(reducerJob).toContain('--run-id "$RUN_ID"');
    expect(reducerJob).toContain('--run-attempt "$RUN_ATTEMPT"');
    expect(reducerJob).toContain('--xcode-version "$IOS_SCREENSHOT_XCODE_VERSION"');
    expect(reducerJob).toContain('--fastlane-version "$IOS_SCREENSHOT_FASTLANE_VERSION"');
    expect(reducerJob).toContain('--node-version "$(node --version)"');
    expect(reducerJob).toContain("steps.reduce_screenshot_evidence.outcome == 'failure'");
    expect(reducerJob).toContain("apps/ios/build/ScreenshotEvidenceInputs/**/xcresults/*.xcresult");
    expect(reducerJob).toContain(
      "name: ios-release-screenshots-${{ needs.preflight.outputs.checkout_revision }}",
    );
    expect(reducerJob).toContain("apps/ios/build/ScreenshotEvidence/manifest.json");
    expect(reducerJob).not.toContain("SnapshotDerivedData");
  });

  it("records the installed Fastlane semver before the update notice", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const parser = workflow.match(/run_ios_fastlane --version 2>&1 \| awk '([^']+)'/u)?.[1];

    expect(parser).toBeDefined();
    const result = spawnSync("awk", [parser!], {
      encoding: "utf8",
      input:
        "fastlane installation at path:\nfastlane 2.236.1\n# fastlane 2.238.0 is available. You are on 2.236.1.\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2.236.1\n");
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

  it("preflights and finalizes mobile release refs only after TestFlight accepts the build", () => {
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
    expect(releaseUpload).toContain("finalize_mobile_release_ref!");
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
    expect(releaseUpload.indexOf("finalize_mobile_release_ref!")).toBeGreaterThan(
      releaseUpload.indexOf("upload_to_testflight("),
    );
  });

  it("keeps local ref recording as the default and emits a closed intent only in CI mode", () => {
    const finalizer = functionBody(readFastfile(), "finalize_mobile_release_ref!");
    const intentContext = functionBody(readFastfile(), "mobile_release_intent_context!");

    expect(finalizer).toContain("unless intent_context");
    expect(finalizer).toContain("record_mobile_release_ref!(");
    expect(intentContext).toContain('unless mode == "intent"');
    expect(finalizer).toContain('"mobile-release-intent.mjs"');
    expect(finalizer).toContain('"--authority-receipt-digest"');
    expect(finalizer).toContain('"--gateway-version"');
    expect(finalizer).toContain('"--app-store-version"');
    expect(finalizer).toContain('"--build-number"');
    expect(finalizer).toContain('"--internal-group-id"');
    expect(finalizer).toContain('"--internal-group-name"');
    expect(finalizer).toContain('"--target-ref"');
    expect(finalizer).toContain('"--target-sha"');
    expect(
      functionBody(readFastfile(), "assign_and_verify_ci_testflight_internal_group!"),
    ).toContain("build.add_beta_groups(beta_groups: [group])");
    expect(finalizer).not.toContain('"git"');
    expect(finalizer).not.toContain("push");
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
