// Verify Stable Main Closeout tests cover stable closeout CLI behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/verify-stable-main-closeout.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

describe("verify-stable-main-closeout", () => {
  it("rejects option-shaped values before checking required arguments", () => {
    const result = runCli("--tag", "-h");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--tag requires a value.");
  });

  it("closes npm releases with apps pending and preserves that snapshot after app attachment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-closeout-"));
    tempDirs.push(dir);
    for (const name of ["main", "tag"]) {
      const root = path.join(dir, name);
      mkdirSync(root);
      execFileSync("git", ["init", "--quiet", root]);
      writeFileSync(path.join(root, ".git/HEAD"), `${"a".repeat(40)}\n`);
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.6.8"}');
      writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 2026.6.8\n\n- Released.\n");
      writeFileSync(path.join(root, "appcast.xml"), "<rss>older app release</rss>");
    }
    const releasePath = path.join(dir, "release.json");
    const outputPath = path.join(dir, "closeout.json");
    const originalPath = path.join(dir, "original.json");
    const evidence = {
      name: "openclaw-2026.6.8-postpublish-evidence.json",
      digest: `sha256:${"b".repeat(64)}`,
    };
    const release = {
      tagName: "v2026.6.8",
      isDraft: false,
      isPrerelease: false,
      assets: [evidence],
    };
    writeFileSync(releasePath, JSON.stringify(release));
    const args = [
      "--tag",
      "v2026.6.8",
      "--main-dir",
      path.join(dir, "main"),
      "--tag-dir",
      path.join(dir, "tag"),
      "--release-json",
      releasePath,
      "--full-release-validation-run-id",
      "11",
      "--full-release-validation-run-attempt",
      "2",
      "--release-publish-run-id",
      "12",
      "--rollback-drill-id",
      "synthetic-drill",
      "--rollback-drill-date",
      new Date().toISOString().slice(0, 10),
      "--output",
      outputPath,
      "--allow-failed-publish-recovery",
      "true",
    ];
    const initial = runCli(...args);
    expect(initial.status, initial.stderr).toBe(0);
    const initialBytes = readFileSync(outputPath, "utf8");
    expect(JSON.parse(initialBytes)).toMatchObject({
      apps: "pending",
      appcast: "pending",
      releasePublishRecovery: { npmDockerVerified: true },
    });
    writeFileSync(originalPath, initialBytes);
    release.assets.push(
      ...[
        "OpenClaw-2026.6.8.zip",
        "OpenClaw-2026.6.8.dmg",
        "OpenClaw-2026.6.8.dSYM.zip",
        "OpenClaw-Android.apk",
        "OpenClaw-Android-SHA256SUMS.txt",
        "OpenClawCompanion-Setup-arm64.exe",
        "OpenClawCompanion-Setup-x64.exe",
        "OpenClawCompanion-SHA256SUMS.txt",
      ].map((name) => ({ name, digest: `sha256:${"c".repeat(64)}` })),
    );
    writeFileSync(releasePath, JSON.stringify(release));
    const missingAppcast = runCli(...args, "--existing-manifest", originalPath);
    expect(missingAppcast.status).toBe(1);
    expect(missingAppcast.stderr).toContain(
      "main appcast.xml does not point at OpenClaw-2026.6.8.zip",
    );
    const publishedAppcastPath = path.join(dir, "published-appcast.xml");
    writeFileSync(
      publishedAppcastPath,
      "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/OpenClaw-2026.6.8.zip",
    );
    const replay = runCli(
      ...args,
      "--existing-manifest",
      originalPath,
      "--published-appcast",
      publishedAppcastPath,
    );
    expect(replay.status, replay.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(initialBytes);

    evidence.digest = `sha256:${"d".repeat(64)}`;
    writeFileSync(releasePath, JSON.stringify(release));
    const changed = runCli(...args, "--existing-manifest", originalPath);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(
      `Recorded release asset changed or disappeared: ${evidence.name}`,
    );
  });
});
