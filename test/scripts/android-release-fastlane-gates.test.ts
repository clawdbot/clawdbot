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

  it("preflights and records mobile release refs around Play build upload", () => {
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
    expect(uploadBuild).toContain("record_mobile_release_ref!");
    expect(uploadBuild.match(/sha: release_sha/g)).toHaveLength(2);
    expect(uploadBuild.indexOf("ensure_mobile_release_ref_available!")).toBeLessThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild.indexOf("record_mobile_release_ref!")).toBeGreaterThan(
      uploadBuild.indexOf("upload_play_builds_atomically!("),
    );
    expect(uploadBuild).toContain("unless play_validate_only?");
    expect(atomicUpload.match(/client\.upload_bundle\(/g)).toHaveLength(2);
    expect(atomicUpload.match(/client\.begin_edit\(/g)).toHaveLength(1);
    expect(atomicUpload.match(/client\.commit_current_edit!/g)).toHaveLength(1);
    expect(atomicUpload).toContain("client.validate_current_edit!");
    expect(atomicUpload).toContain("client.abort_current_edit");
    expect(atomicUpload).toContain("upload_play_listing_assets!");
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
