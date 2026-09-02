// Android Fastlane release gate tests keep Play uploads tied to mobile release refs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fastfilePath = path.join(process.cwd(), "apps", "android", "fastlane", "Fastfile");

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

    expect(fastfile).toContain("def mobile_release_ref_command");
    expect(fastfile).toContain("def release_git_sha");
    expect(fastfile).toContain('"--root"');
    expect(fastfile).toContain('"--sha"');
    expect(fastfile).toContain("repo_root");
    expect(uploadBuild).toContain("release_sha = release_git_sha");
    expect(uploadBuild).toContain("ensure_mobile_release_ref_available!");
    expect(uploadBuild).toContain("finalize_mobile_release_ref!");
    expect(uploadBuild.match(/sha: release_sha/g)).toHaveLength(2);
    expect(uploadBuild.indexOf("ensure_mobile_release_ref_available!")).toBeLessThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild.indexOf("finalize_mobile_release_ref!")).toBeGreaterThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild).toContain("accepted = upload_play_builds_atomically!(");
    expect(uploadBuild).toContain("phone_version_code: accepted.fetch(:phone_version_code)");
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

    expect(finalizer).toContain('ENV.fetch("OPENCLAW_MOBILE_RELEASE_REF_MODE", "").strip');
    expect(finalizer).toContain("record_mobile_release_ref!(");
    expect(finalizer).toContain('unless mode == "intent"');
    expect(finalizer).toContain('"mobile-release-intent.mjs"');
    expect(finalizer).toContain('"--authority-receipt-digest"');
    expect(finalizer).toContain('"--gateway-version"');
    expect(finalizer).toContain('"--version-name"');
    expect(finalizer).toContain('"--phone-version-code"');
    expect(finalizer).toContain('"--wear-version-code"');
    expect(finalizer).toContain('"--target-ref"');
    expect(finalizer).toContain('"--target-sha"');
    expect(finalizer).not.toContain('"git"');
    expect(finalizer).not.toContain("push");
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
