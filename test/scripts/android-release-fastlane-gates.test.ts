// Android Fastlane release gate tests keep Play uploads tied to mobile release refs.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const fastfilePath = path.join(process.cwd(), "apps", "android", "fastlane", "Fastfile");
const rubyVersionPath = path.join(process.cwd(), "apps", "android", ".ruby-version");
const gemfilePath = path.join(process.cwd(), "apps", "android", "Gemfile");
const gemfileLockPath = path.join(process.cwd(), "apps", "android", "Gemfile.lock");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readFastfile(): string {
  return readFileSync(fastfilePath, "utf8");
}

function functionBody(source: string, name: string): string {
  const startMarker = `def ${name}`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastlane helper ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextDef = rest.search(/\n(?:def|load_env_file|platform) /);
  return nextDef < 0 ? rest : rest.slice(0, nextDef);
}

function laneBody(source: string, name: string): string {
  const startMarker = `lane :${name} do`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastlane lane ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextLane = rest.search(/\n\s*(?:desc |lane :|end\nend)/);
  return nextLane < 0 ? rest : rest.slice(0, nextLane);
}

describe("Android Fastlane release upload gates", () => {
  it("pins Ruby and the complete Fastlane dependency graph", () => {
    const gemfile = readFileSync(gemfilePath, "utf8");
    const lockfile = readFileSync(gemfileLockPath, "utf8");

    expect(readFileSync(rubyVersionPath, "utf8")).toBe("3.4.10\n");
    expect(gemfile).toContain('ruby "3.4.10"');
    expect(gemfile).toContain('gem "fastlane", "2.238.0"');
    expect(lockfile).toContain("fastlane (2.238.0)");
    expect(lockfile).toContain("arm64-darwin");
    expect(lockfile).toContain("x86_64-darwin");
    expect(lockfile).toContain("aarch64-linux");
    expect(lockfile).toContain("x86_64-linux");
    expect(lockfile).toContain("CHECKSUMS");
    expect(lockfile).toContain("RUBY VERSION\n   ruby 3.4.10");
    expect(lockfile).toContain("BUNDLED WITH\n   2.6.9");
  });

  it("publishes Wear releases to the matching form-factor track", () => {
    const wearTrack = functionBody(readFastfile(), "wear_play_track");

    expect(wearTrack).toContain('"wear:#{play_track}"');
    expect(wearTrack).not.toContain('"qa"');
  });

  it("executes the app and Wear signing validators during release preflight", () => {
    const validation = functionBody(readFastfile(), "validate_android_release_signing!");

    expect(validation).toContain('":app:validateSigningPlayRelease"');
    expect(validation).toContain('":wear:validateSigningRelease"');
    expect(validation).toContain('"-PopenclawBuildCommit=#{build_commit}"');
    expect(validation).toContain('"-PopenclawBuildTimestamp=#{build_timestamp}"');
    expect(validation).not.toContain("--dry-run");
    expect(validation).not.toContain(":app:bundlePlayRelease");
    expect(validation).not.toContain(":wear:bundleRelease");
  });

  it("preflights and finalizes mobile release refs only after Play accepts both builds", () => {
    const fastfile = readFastfile();
    const uploadBuild = functionBody(fastfile, "upload_play_store_build!");
    const atomicUpload = functionBody(fastfile, "upload_play_builds_atomically!");
    const booleanEnv = functionBody(fastfile, "fastlane_boolean_env");
    const intentContext = functionBody(fastfile, "mobile_release_intent_context!");

    expect(fastfile).toContain("def mobile_release_ref_command");
    expect(fastfile).toContain("def release_git_sha");
    expect(fastfile).toContain('"--root"');
    expect(fastfile).toContain('"--sha"');
    expect(fastfile).toContain("repo_root");
    expect(uploadBuild).toContain("release_sha = release_git_sha");
    expect(uploadBuild).toContain(
      "intent_context = mobile_release_intent_context!(gateway_version: version_metadata.fetch(:version))",
    );
    expect(uploadBuild).toContain("ensure_mobile_release_ref_available!");
    expect(uploadBuild).toContain("finalize_mobile_release_ref!");
    expect(uploadBuild.match(/sha: release_sha/g)).toHaveLength(2);
    expect(uploadBuild.indexOf("ensure_mobile_release_ref_available!")).toBeLessThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild.indexOf("mobile_release_intent_context!")).toBeLessThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild.indexOf("finalize_mobile_release_ref!")).toBeGreaterThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild).toContain("accepted = upload_play_builds_atomically!(");
    expect(uploadBuild).toContain("phone_track: play_track");
    expect(uploadBuild).toContain("phone_version_code: accepted.fetch(:phone_version_code)");
    expect(uploadBuild).toContain('play_edit_state: "committed"');
    expect(uploadBuild).toContain("release_status: play_release_status");
    expect(uploadBuild).toContain("wear_track: wear_play_track");
    expect(uploadBuild).toContain("wear_version_code: accepted.fetch(:wear_version_code)");
    expect(uploadBuild).toContain("unless play_validate_only?");
    expect(atomicUpload.match(/client\.upload_bundle\(/g)).toHaveLength(2);
    expect(atomicUpload.match(/client\.begin_edit\(/g)).toHaveLength(1);
    expect(atomicUpload.match(/client\.commit_current_edit!/g)).toHaveLength(1);
    expect(atomicUpload).toContain("client.validate_current_edit!");
    expect(atomicUpload).toContain("client.abort_current_edit");
    expect(atomicUpload).toContain("upload_play_listing_assets!");
    expect(atomicUpload.indexOf("client.commit_current_edit!")).toBeLessThan(
      atomicUpload.indexOf("phone_version_code: phone_version_code.to_i"),
    );
    expect(fastfile).toContain("Supply::SCREENSHOT_TYPES.each");
    expect(fastfile).toContain("%w(phoneScreenshots wearScreenshots)");
    expect(booleanEnv).toContain('["1", "yes", "true", "on"]');
    expect(booleanEnv).toContain('["0", "no", "false", "off"]');
    expect(intentContext).toContain("OPENCLAW_MOBILE_RELEASE_REF_MODE");
    expect(intentContext).toContain("OPENCLAW_MOBILE_RELEASE_INTENT_PATH");
    expect(intentContext).toContain("OPENCLAW_MOBILE_RELEASE_AUTHORITY_RECEIPT_DIGEST");
    expect(intentContext).toContain("OPENCLAW_MOBILE_RELEASE_TARGET_REF");
    expect(atomicUpload).toContain(
      'fastlane_boolean_env("ACK_BUNDLE_INSTALLATION_WARNING", default: false)',
    );
    expect(atomicUpload).toContain(
      'fastlane_boolean_env("SUPPLY_RESCUE_CHANGES_NOT_SENT_FOR_REVIEW", default: true)',
    );
  });

  it("keeps local ref recording as the default and emits a closed intent only in CI mode", () => {
    const fastfile = readFastfile();
    const finalizer = functionBody(fastfile, "finalize_mobile_release_ref!");
    const intentContext = functionBody(fastfile, "mobile_release_intent_context!");

    expect(finalizer).toContain("unless intent_context");
    expect(finalizer).toContain("record_mobile_release_ref!(");
    expect(intentContext).toContain('unless mode == "intent"');
    expect(finalizer).toContain('"mobile-release-intent.mjs"');
    expect(finalizer).toContain('"--authority-receipt-digest"');
    expect(finalizer).toContain('"--gateway-version"');
    expect(finalizer).toContain('"--phone-track"');
    expect(finalizer).toContain('"--version-name"');
    expect(finalizer).toContain('"--phone-version-code"');
    expect(finalizer).toContain('"--play-edit-state"');
    expect(finalizer).toContain('"--release-status"');
    expect(finalizer).toContain('"--wear-track"');
    expect(finalizer).toContain('"--wear-version-code"');
    expect(finalizer).toContain('"--target-ref"');
    expect(finalizer).toContain('"--target-sha"');
    expect(finalizer).not.toContain('"git"');
    expect(finalizer).not.toContain("push");
  });

  it("requires locked wrapper provenance after loading intent mode from .env", () => {
    const fastfile = readFastfile();
    const marker = "_OPENCLAW_ANDROID_FASTLANE_EXECUTION_PROVENANCE";
    const loader = functionBody(fastfile, "load_env_file");
    const provenance = functionBody(fastfile, "validate_android_fastlane_execution_provenance!");
    const envPath = path.join(tempDirs.make("openclaw-android-fastlane-env-"), ".env");
    writeFileSync(
      envPath,
      ["OPENCLAW_MOBILE_RELEASE_REF_MODE=intent", `${marker}=locked`, ""].join("\n"),
    );
    const source = `
module UI
  def self.user_error!(message)
    raise message
  end
end
ANDROID_FASTLANE_EXECUTION_PROVENANCE_ENV = "${marker}"
def load_env_file${loader}
def validate_android_fastlane_execution_provenance!${provenance}
def run_case(path, provenance)
  ENV.delete("OPENCLAW_MOBILE_RELEASE_REF_MODE")
  ENV.delete(ANDROID_FASTLANE_EXECUTION_PROVENANCE_ENV)
  ENV[ANDROID_FASTLANE_EXECUTION_PROVENANCE_ENV] = provenance unless provenance == "missing"
  load_env_file(path)
  begin
    validate_android_fastlane_execution_provenance!
    puts "ok:#{ENV.fetch(ANDROID_FASTLANE_EXECUTION_PROVENANCE_ENV, "missing")}"
  rescue => error
    puts "error:#{error.message}:#{ENV.fetch(ANDROID_FASTLANE_EXECUTION_PROVENANCE_ENV, "missing")}"
  end
end
run_case(ARGV.fetch(0), "fallback")
run_case(ARGV.fetch(0), "locked")
run_case(ARGV.fetch(0), "missing")
`;
    const result = spawnSync("ruby", ["-e", source, envPath], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "error:Protected Android beta CI requires the checksum-locked Android Fastlane bundle.:fallback",
      "ok:locked",
      "error:Protected Android beta CI requires the checksum-locked Android Fastlane bundle.:missing",
    ]);
    expect(loader).toContain("next if key == ANDROID_FASTLANE_EXECUTION_PROVENANCE_ENV");
    const envLoad = fastfile.indexOf('load_env_file(File.join(ANDROID_FASTLANE_ROOT, ".env"))');
    const provenanceCheck = fastfile.indexOf(
      "\nvalidate_android_fastlane_execution_provenance!",
      envLoad,
    );
    const platform = fastfile.indexOf("\nplatform :android do", provenanceCheck);
    expect(envLoad).toBeGreaterThan(-1);
    expect(provenanceCheck).toBeGreaterThan(envLoad);
    expect(platform).toBeGreaterThan(provenanceCheck);
  });

  it("validates the complete Android intent context before store mutation", () => {
    const intentContext = functionBody(readFastfile(), "mobile_release_intent_context!");
    const source = `
module UI
  def self.user_error!(message)
    raise message
  end
end
def mobile_release_intent_context!${intentContext}
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

  it("fails before upload when planned Play codes are already consumed", () => {
    const fastfile = readFastfile();
    const auth = functionBody(fastfile, "validate_play_auth!");
    const preflight = functionBody(fastfile, "validate_android_release_preflight!");
    const destination = functionBody(fastfile, "validate_ci_play_destination!");

    expect(auth).toContain("client.aab_version_codes.map(&:to_i)");
    expect(auth).toContain("expected_codes & consumed_codes");
    expect(auth).toContain("Cut a new mobile release plan before uploading.");
    expect(preflight).toContain("validate_play_auth!(version_metadata: version_metadata)");
    expect(destination).toContain('play_track == "internal"');
    expect(destination).toContain('wear_play_track == "wear:internal"');
  });

  it("generates fresh screenshots before building and uploading a release", () => {
    const releaseUpload = laneBody(readFastfile(), "release_upload");

    expect(releaseUpload).toContain("screenshots");
    expect(releaseUpload.indexOf("screenshots")).toBeLessThan(
      releaseUpload.indexOf("build_release_artifacts!"),
    );
    expect(releaseUpload.indexOf("screenshots")).toBeLessThan(
      releaseUpload.indexOf("upload_play_store_build!"),
    );
    expect(releaseUpload).toContain('ENV["SUPPLY_UPLOAD_SCREENSHOTS"] = "1"');
    expect(readFastfile()).toContain("*.{png,jpg,jpeg}");
  });
});
