// Package Changelog tests cover package changelog script behavior.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractCurrentPackageChangelog,
  preparePackageChangelog,
  resolvePackageChangelogVersions,
  restorePackageChangelog,
} from "../../scripts/package-changelog.mjs";

function changelog(strings: TemplateStringsArray, ...values: string[]) {
  return `${String.raw({ raw: strings }, ...values)
    .replace(/^\n/u, "")
    .trimEnd()}\n`;
}

const cumulativeChangelog = changelog`
# Changelog
Docs: https://docs.openclaw.ai
## Unreleased
### Fixes
- Pending note.
## 2026.5.28
### Highlights
- Current highlight.
### Changes
- Current change.
### Fixes
- Current fix.
## 2026.5.27
### Highlights
- Older highlight.
`;

describe("package-changelog", () => {
  it("maps release-channel package versions to package changelog candidate headings", () => {
    expect(resolvePackageChangelogVersions("2026.5.28")).toEqual(["2026.5.28"]);
    expect(resolvePackageChangelogVersions("2026.5.28-1")).toEqual(["2026.5.28-1"]);
    expect(resolvePackageChangelogVersions("2026.5.28-beta.1")).toEqual([
      "2026.5.28-beta.1",
      "2026.5.28",
      "Unreleased",
    ]);
    expect(resolvePackageChangelogVersions("2026.5.28-alpha.2")).toEqual([
      "2026.5.28-alpha.2",
      "2026.5.28",
      "Unreleased",
    ]);
    expect(resolvePackageChangelogVersions("2026.5.29", { allowUnreleased: true })).toEqual([
      "2026.5.29",
      "Unreleased",
    ]);
  });

  it("extracts only the package version stable release section", () => {
    expect(extractCurrentPackageChangelog(cumulativeChangelog, "2026.5.28-beta.1")).toBe(
      changelog`
# Changelog
Docs: https://docs.openclaw.ai

## 2026.5.28
### Highlights
- Current highlight.
### Changes
- Current change.
### Fixes
- Current fix.
`,
    );
  });

  it("prefers an exact prerelease section when it exists", () => {
    const source = changelog`
# Changelog
## 2026.5.28-beta.2
- Beta 2 package notes with enough release detail.
## 2026.5.28
- Stable.
`;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-beta.2")).toBe(changelog`
# Changelog

## 2026.5.28-beta.2
- Beta 2 package notes with enough release detail.
`);
  });

  it("uses Unreleased only as a prerelease fallback when no release heading exists", () => {
    const source = changelog`
# Changelog
## Unreleased
- Pending beta package notes with enough release detail.
## 2026.5.27
- Older stable.
`;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-beta.1")).toBe(changelog`
# Changelog

## Unreleased
- Pending beta package notes with enough release detail.
`);
  });

  it("extracts exact correction release sections", () => {
    const source = changelog`
# Changelog
## 2026.5.28-1
- Correction release notes with enough detail.
## 2026.5.28
- Stable.
`;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-1")).toBe(changelog`
# Changelog

## 2026.5.28-1
- Correction release notes with enough detail.
`);
  });

  it("fails closed when package version has no matching release section", () => {
    expect(() => extractCurrentPackageChangelog(cumulativeChangelog, "2026.5.29")).toThrow(
      "CHANGELOG.md does not contain a release section for 2026.5.29.",
    );
  });

  it("allows Unreleased notes for explicitly non-publish stable artifacts", () => {
    const unreleasedChangelog = cumulativeChangelog.replace(
      "- Pending note.",
      "- Pending release note with enough detail.",
    );
    expect(
      extractCurrentPackageChangelog(unreleasedChangelog, "2026.5.29", {
        allowUnreleased: true,
      }),
    ).toBe(changelog`
# Changelog
Docs: https://docs.openclaw.ai

## Unreleased
### Fixes
- Pending release note with enough detail.
`);
  });

  it("does not fall back when exact non-publish notes fail safety checks", () => {
    const source = changelog`
# Changelog
## Unreleased
- Pending development package notes with enough release detail.
## 2026.5.29
- Tiny.
## 2026.5.28
- Older stable release notes with enough detail.
`;

    expect(() =>
      extractCurrentPackageChangelog(source, "2026.5.29", { allowUnreleased: true }),
    ).toThrow("Packaged changelog section for 2026.5.29 is only 7 body bytes");
  });

  it("fails closed when the packaged changelog is unexpectedly large", () => {
    const source = changelog`
# Changelog
## 2026.5.28
${"é".repeat(260_000)}
`;

    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "exceeds the 512000 byte safety limit",
    );
  });

  it("fails closed when the extracted release section is effectively empty", () => {
    const source = changelog`
# Changelog
Docs: https://docs.openclaw.ai
## 2026.5.28
### Fixes
## 2026.5.27
- Older stable release notes with enough detail.
`;

    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "below the 32 byte safety minimum",
    );
  });

  it("prepares and restores the packaged changelog without changing the source permanently", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
    try {
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n', "utf8");
      writeFileSync(path.join(root, "CHANGELOG.md"), cumulativeChangelog, "utf8");

      await expect(preparePackageChangelog(root)).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain("## Unreleased");
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain("## 2026.5.27");
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain("## 2026.5.28");

      await expect(restorePackageChangelog(root)).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(cumulativeChangelog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted ephemeral QA package with the default restore path", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
    const unreleasedChangelog = cumulativeChangelog.replace(
      "- Pending note.",
      "- Pending release note with enough detail.",
    );
    try {
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.29"}\n', "utf8");
      writeFileSync(path.join(root, "CHANGELOG.md"), unreleasedChangelog, "utf8");

      await expect(preparePackageChangelog(root, { allowUnreleased: true })).resolves.toBe(true);
      await expect(restorePackageChangelog(root)).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(unreleasedChangelog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to restore stale backups over current changelog edits", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
    const backupPath = path.join(
      root,
      ".artifacts",
      "package-changelog",
      "CHANGELOG.md.prepack-backup",
    );
    const editedChangelog = cumulativeChangelog.replace("- Current fix.", "- Current fix edited.");
    try {
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n', "utf8");
      writeFileSync(path.join(root, "CHANGELOG.md"), editedChangelog, "utf8");
      mkdirSync(path.dirname(backupPath), { recursive: true });
      writeFileSync(backupPath, cumulativeChangelog, "utf8");

      await expect(restorePackageChangelog(root)).rejects.toThrow(
        "Refusing to restore packaged changelog backup",
      );
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(editedChangelog);
      expect(existsSync(backupPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
