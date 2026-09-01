import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = "scripts/lib/mac-notarization-recovery.py";
const sourceSha = "a".repeat(40);
const version = "2026.8.2";

function recoveryFixture(archiveCase = "valid") {
  const root = tempDirs.make("mac-notary-checkpoint-");
  const archive = path.join(root, "app.zip");
  const create = spawnSync(
    "python3",
    [
      "-c",
      `
import stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("OpenClaw.app/Contents/Info.plist", "signed bundle metadata")
    if sys.argv[2] == "traversal":
        archive.writestr("OpenClaw.app/../../outside", "escape")
    if sys.argv[2] in ("escaping-link", "valid"):
        entry = zipfile.ZipInfo("OpenClaw.app/Contents/Frameworks/Current")
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(entry, "../../../outside" if sys.argv[2] == "escaping-link" else "VersionA")
`,
      archive,
      archiveCase,
    ],
    { encoding: "utf8" },
  );
  expect(create.status, create.stderr).toBe(0);
  writeFileSync(path.join(root, "symbols.zip"), "symbols");
  const run = (command: string, ...args: string[]) =>
    spawnSync("python3", [script, command, root, ...args], { encoding: "utf8" });
  const initialized = run("init", sourceSha, version, "202609011", "0", "0");
  expect(initialized.status, initialized.stderr).toBe(0);
  return { root, archive, run, manifest: path.join(root, "manifest.json") };
}

describe("retained macOS notarization artifacts", () => {
  it("seals updated publication artifacts while allowing the separate workflow envelope", () => {
    const fixture = recoveryFixture();
    writeFileSync(
      path.join(fixture.root, "workflow-release.json"),
      JSON.stringify({ runId: "123" }),
    );
    writeFileSync(path.join(fixture.root, "sparkle-tools.zip"), "signing tools");
    writeFileSync(
      path.join(fixture.root, "app-submission.json"),
      JSON.stringify({ submissionId: "apple-id" }),
    );
    writeFileSync(path.join(fixture.root, "app.dmg"), "signed dmg");
    writeFileSync(
      path.join(fixture.root, "dmg-submission.json"),
      JSON.stringify({ submissionId: "dmg-id" }),
    );
    expect(fixture.run("seal").status).toBe(0);
    const verified = fixture.run("verify", sourceSha, version);
    expect(verified.status, verified.stderr).toBe(0);
    const manifest = JSON.parse(verified.stdout);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourceSha,
      version,
      build: "202609011",
      skipDmg: false,
      skipDsym: false,
    });
    expect(Object.keys(manifest.files).toSorted()).toEqual([
      "app-submission.json",
      "app.dmg",
      "app.zip",
      "dmg-submission.json",
      "sparkle-tools.zip",
      "symbols.zip",
    ]);
    expect(manifest.files["sparkle-tools.zip"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(readFileSync(fixture.manifest, "utf8"))).toEqual(manifest);
  });

  it.each(["artifact tamper", "source mismatch", "version mismatch", "manifest symlink"])(
    "rejects %s before restoring artifacts",
    (scenario) => {
      const fixture = recoveryFixture();
      let source = sourceSha;
      let releaseVersion = version;
      if (scenario === "artifact tamper") {
        writeFileSync(fixture.archive, "different artifact");
      } else if (scenario === "source mismatch") {
        source = "b".repeat(40);
      } else if (scenario === "version mismatch") {
        releaseVersion = "2026.8.3";
      } else {
        const link = path.join(fixture.root, "manifest-link.json");
        symlinkSync(fixture.manifest, link);
        renameSync(link, fixture.manifest);
      }
      const rejected = fixture.run("verify", source, releaseVersion);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("macOS notarization recovery:");
      expect(rejected.stdout).toBe("");
    },
  );

  it.each(["traversal", "escaping-link"])("rejects a sealed app archive with %s", (archiveCase) => {
    const fixture = recoveryFixture(archiveCase);
    const rejected = fixture.run("verify", sourceSha, version);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/unsafe path|symlink escapes/u);
    expect(rejected.stdout).toBe("");
  });
});
