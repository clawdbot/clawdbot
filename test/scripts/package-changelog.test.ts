// Package Changelog tests cover package changelog script behavior.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractCurrentPackageChangelog,
  preparePackageChangelog,
  resolvePackageChangelogVersions,
  restorePackageChangelog,
} from "../../scripts/package-changelog.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function changelog(strings: TemplateStringsArray, ...values: string[]) {
  return `${String.raw({ raw: strings }, ...values)
    .replace(/^\n/u, "")
    .trimEnd()}\n`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
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

const oversizedContributionRecord = `### Complete contribution record

${"- **PR #123** Thanks @contributor.\n".repeat(20_000)}`;
const oversizedChangelog = cumulativeChangelog.replace(
  "## 2026.5.27",
  `${oversizedContributionRecord}\n## 2026.5.27`,
);

const oversizedAccountingLedger = `### Release accounting

- Pull requests: **16,902**
- Direct commits: **698**

### Pull requests

${"- [#123](https://github.com/openclaw/openclaw/pull/123) Contribution (@contributor).\n".repeat(20_000)}
### Direct commits

- [\`1234567\`](https://github.com/openclaw/openclaw/commit/1234567890123456789012345678901234567890) Direct fix (Contributor).`;

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

  it.each(["", oversizedContributionRecord])(
    "refuses oversized editorial notes even with a contribution record (%#)",
    (record) => {
      const source = changelog`
# Changelog
## 2026.5.28
${"é".repeat(260_000)}
${record}
`;

      expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
        "exceeds the 512000 byte safety limit",
      );
    },
  );

  it.each(["2026.5.28", "2026.5.28-beta.1", "2026.5.28-alpha.2", "2026.5.28-1"])(
    "compacts only an oversized contribution record and pins the exact %s tag",
    (version) => {
      const editorial = `## ${version}\n\n### Fixes\n\n- Preserve this complete user-facing note and credit. Thanks @contributor.`;
      const source = `# Changelog\n\n${editorial}\n\n${oversizedContributionRecord}\n`;
      const packaged = extractCurrentPackageChangelog(source, version);
      expect(packaged).toBe(
        `# Changelog\n\n${editorial}\n\n### Complete contribution record\n\nThe full contribution record is available in the tag-pinned [CHANGELOG.md](https://github.com/openclaw/openclaw/blob/v${version}/CHANGELOG.md#complete-contribution-record).\n`,
      );
    },
  );

  it("requires an immutable source commit for an oversized accounting ledger", () => {
    const source = `# Changelog\n\n## 2026.5.28\n\n${oversizedAccountingLedger}\n`;
    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "accounting ledger compaction requires its immutable source commit",
    );
  });

  it("compacts an oversized accounting ledger behind its commit-pinned PR record", () => {
    const sourceCommit = "a".repeat(40);
    const source = `# Changelog\n\n## 2026.5.28\n\n${oversizedAccountingLedger}\n`;
    const packaged = extractCurrentPackageChangelog(source, "2026.5.28", { sourceCommit });

    expect(packaged).toContain("### Release accounting");
    expect(packaged).toContain("### Pull requests and direct commits");
    expect(packaged).toContain(
      `https://github.com/openclaw/openclaw/blob/${sourceCommit}/CHANGELOG.md#pull-requests`,
    );
    expect(packaged).not.toContain("[#123](https://github.com/openclaw/openclaw/pull/123)");
    expect(packaged).not.toContain("### Direct commits");
  });

  it("pins prepared accounting ledgers to the commit that contains the full record", async () => {
    const root = tempDirs.make("openclaw-package-ledger-");
    const source = `# Changelog\n\n## 2026.5.28\n\n${oversizedAccountingLedger}\n`;
    try {
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28"}\n', "utf8");
      writeFileSync(path.join(root, "CHANGELOG.md"), source, "utf8");
      git(root, ["init", "-q"]);
      git(root, ["config", "user.name", "Release Test"]);
      git(root, ["config", "user.email", "release-test@example.com"]);
      git(root, ["add", "package.json", "CHANGELOG.md"]);
      git(root, ["commit", "-qm", "release source"]);
      const sourceCommit = git(root, ["rev-parse", "HEAD"]);
      expect(git(root, ["show", `${sourceCommit}:CHANGELOG.md`])).toContain(
        "[#123](https://github.com/openclaw/openclaw/pull/123)",
      );

      await expect(preparePackageChangelog(root)).resolves.toBe(true);
      const packaged = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
      expect(packaged).toContain(
        `https://github.com/openclaw/openclaw/blob/${sourceCommit}/CHANGELOG.md#pull-requests`,
      );
      await expect(restorePackageChangelog(root)).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses explicit source provenance when packaging a gitless archive", async () => {
    const root = tempDirs.make("openclaw-package-ledger-archive-");
    const sourceCommit = "b".repeat(40);
    const source = `# Changelog\n\n## 2026.5.28\n\n${oversizedAccountingLedger}\n`;
    try {
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28"}\n', "utf8");
      writeFileSync(path.join(root, "CHANGELOG.md"), source, "utf8");

      await expect(preparePackageChangelog(root, { sourceCommit })).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain(
        `https://github.com/openclaw/openclaw/blob/${sourceCommit}/CHANGELOG.md#pull-requests`,
      );
      await expect(restorePackageChangelog(root, { sourceCommit })).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not use the generated contribution link to satisfy the release-note minimum", () => {
    const source = `# Changelog\n\n## 2026.5.28\n\n### Fixes\n\n${oversizedContributionRecord}\n`;
    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "below the 32 byte safety minimum",
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

  it.each([cumulativeChangelog, oversizedChangelog])(
    "prepares and restores all source notes and credits (%#)",
    async (sourceChangelog) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
      try {
        writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n', "utf8");
        writeFileSync(path.join(root, "CHANGELOG.md"), sourceChangelog, "utf8");

        await expect(preparePackageChangelog(root)).resolves.toBe(true);
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain(
          "## Unreleased",
        );
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain("## 2026.5.27");
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain("## 2026.5.28");

        await expect(restorePackageChangelog(root)).resolves.toBe(true);
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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

  it.each([cumulativeChangelog, oversizedChangelog])(
    "refuses to restore over edits after package preparation (%#)",
    async (sourceChangelog) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
      const backupPath = path.join(
        root,
        ".artifacts",
        "package-changelog",
        "CHANGELOG.md.prepack-backup",
      );

      try {
        writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n', "utf8");
        writeFileSync(path.join(root, "CHANGELOG.md"), sourceChangelog, "utf8");
        await preparePackageChangelog(root);
        const editedChangelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8").replace(
          "- Current fix.",
          "- Current fix edited.",
        );
        writeFileSync(path.join(root, "CHANGELOG.md"), editedChangelog, "utf8");

        await expect(restorePackageChangelog(root)).rejects.toThrow(
          "Refusing to restore packaged changelog backup",
        );
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(editedChangelog);
        expect(existsSync(backupPath)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
