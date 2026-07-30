import { describe, expect, it } from "vitest";
import {
  GITHUB_RELEASE_BODY_MAX_BYTES,
  GITHUB_RELEASE_BODY_MAX_CHARACTERS,
  extractChangelogSection,
  formatShippedBaselineExclusions,
  parseShippedBaselineExclusions,
  releaseNotesVersionForTag,
  renderGithubReleaseNotes,
  verifyGithubReleaseNotes,
} from "../../scripts/render-github-release-notes.mjs";

const repository = "openclaw/openclaw";
const tag = "v2026.7.1-beta.3";
const version = "2026.7.1";

function changelogFor(record: string): string {
  return [
    "# Changelog",
    "",
    `## ${version}`,
    "",
    "### Highlights",
    "",
    "- A grouped user-facing highlight.",
    "",
    "### Fixes",
    "",
    "- A grouped user-facing fix.",
    "",
    "### Complete contribution record",
    "",
    record,
    "",
    "## 2026.6.11",
    "",
    "- Previous release.",
    "",
  ].join("\n");
}

describe("GitHub release-note rendering", () => {
  it("emits the complete matching section including its version heading when it fits", () => {
    const rendered = renderGithubReleaseNotes({
      changelog: changelogFor("- **PR #123** fix: example. Thanks @contributor."),
      version,
      tag,
      repository,
    });

    expect(rendered.mode).toBe("full");
    expect(rendered.body).toBe(
      [
        `## ${version}`,
        "",
        "### Highlights",
        "",
        "- A grouped user-facing highlight.",
        "",
        "### Fixes",
        "",
        "- A grouped user-facing fix.",
        "",
        "### Complete contribution record",
        "",
        "- **PR #123** fix: example. Thanks @contributor.",
      ].join("\n"),
    );
  });

  it("replaces an oversized contribution record with a tag-pinned link", () => {
    const oversizedRecord = `- **PR #123** ${"record-only-detail ".repeat(9_000)}`;
    const rendered = renderGithubReleaseNotes({
      changelog: changelogFor(oversizedRecord),
      version,
      tag,
      repository,
    });

    expect(rendered.mode).toBe("compact");
    expect(rendered.body).toContain(`## ${version}\n\n### Highlights`);
    expect(rendered.body).toContain("- A grouped user-facing fix.");
    expect(rendered.body).toContain("### Complete contribution record");
    expect(rendered.body).toContain(
      "https://github.com/openclaw/openclaw/blob/v2026.7.1-beta.3/CHANGELOG.md#complete-contribution-record",
    );
    expect(rendered.body).not.toContain("record-only-detail");
    expect(rendered.size.characters).toBeLessThanOrEqual(GITHUB_RELEASE_BODY_MAX_CHARACTERS);
    expect(rendered.size.bytes).toBeLessThanOrEqual(GITHUB_RELEASE_BODY_MAX_BYTES);
  });

  it("keeps a fitting full section and omits only a proof tail that would overflow", () => {
    const nearlyFullRecord = `- **PR #123** ${"x".repeat(124_500)}`;
    const changelog = changelogFor(nearlyFullRecord);
    const withoutProof = renderGithubReleaseNotes({
      changelog,
      version,
      tag,
      repository,
    });
    const withProof = renderGithubReleaseNotes({
      changelog,
      version,
      tag,
      repository,
      verification: `### Release verification\n\n- proof: ${"y".repeat(1_000)}`,
    });

    expect(withoutProof.mode).toBe("full");
    expect(withProof.mode).toBe("full");
    expect(withProof.verificationIncluded).toBe(false);
    expect(withProof.verificationOmitted).toBe(true);
    expect(withProof.body).toBe(withoutProof.body);
    expect(withProof.body).not.toContain("### Release verification");
    expect(withProof.size.characters).toBeLessThanOrEqual(GITHUB_RELEASE_BODY_MAX_CHARACTERS);
    expect(withProof.size.bytes).toBeLessThanOrEqual(GITHUB_RELEASE_BODY_MAX_BYTES);
  });

  it("uses the full form at exactly 125,000 bytes and compacts at 125,001", () => {
    const seed = renderGithubReleaseNotes({
      changelog: changelogFor("x"),
      version,
      tag,
      repository,
    });
    const exactRecordLength =
      GITHUB_RELEASE_BODY_MAX_BYTES - seed.size.bytes + Buffer.byteLength("x");
    const exact = renderGithubReleaseNotes({
      changelog: changelogFor("x".repeat(exactRecordLength)),
      version,
      tag,
      repository,
    });
    const over = renderGithubReleaseNotes({
      changelog: changelogFor("x".repeat(exactRecordLength + 1)),
      version,
      tag,
      repository,
    });

    expect(exact.mode).toBe("full");
    expect(exact.size).toEqual({
      characters: GITHUB_RELEASE_BODY_MAX_CHARACTERS,
      bytes: GITHUB_RELEASE_BODY_MAX_BYTES,
    });
    expect(over.mode).toBe("compact");
  });

  it("compacts when multibyte text exceeds the byte limit before the character limit", () => {
    const rendered = renderGithubReleaseNotes({
      changelog: changelogFor("é".repeat(63_000)),
      version,
      tag,
      repository,
    });

    expect(rendered.mode).toBe("compact");
    expect(rendered.size.bytes).toBeLessThanOrEqual(GITHUB_RELEASE_BODY_MAX_BYTES);
    expect(rendered.size.characters).toBeLessThanOrEqual(GITHUB_RELEASE_BODY_MAX_CHARACTERS);
  });

  it("normalizes correction tags to the stable changelog section", () => {
    expect(releaseNotesVersionForTag("v2026.7.1-2")).toBe("2026.7.1");
    const rendered = renderGithubReleaseNotes({
      changelog: changelogFor("- **PR #123** fix: correction."),
      version,
      tag: "v2026.7.1-2",
      repository,
    });

    expect(rendered.body).toContain("## 2026.7.1");
  });

  it("prefers a correction tag's dedicated changelog section when one exists", () => {
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1-2",
      "",
      "- Correction-only fix.",
      "",
      `## ${version}`,
      "",
      "- Stable release notes.",
      "",
    ].join("\n");
    const rendered = renderGithubReleaseNotes({
      changelog,
      version,
      tag: "v2026.7.1-2",
      repository,
    });

    expect(rendered.body).toContain("## 2026.7.1-2");
    expect(rendered.body).toContain("Correction-only fix.");
    expect(rendered.body).not.toContain("Stable release notes.");
  });

  it("round-trips canonical shipped baseline exclusions and rejects malformed metadata", () => {
    const line = formatShippedBaselineExclusions([
      { ref: "v2026.6.11", count: 2, pullRequests: [108, 101] },
      { ref: "v2026.6.10-beta.2", count: 0, pullRequests: [] },
    ]);

    expect(line).toBe(
      "Shipped baseline exclusions: v2026.6.10-beta.2 (0 PRs); v2026.6.11 (2 PRs: #101, #108).",
    );
    expect(parseShippedBaselineExclusions(line)).toEqual([
      { ref: "v2026.6.10-beta.2", count: 0, pullRequests: [] },
      { ref: "v2026.6.11", count: 2, pullRequests: [101, 108] },
    ]);
    expect(() =>
      parseShippedBaselineExclusions("Shipped baseline exclusion: v2026.6.11 (8 PRs)."),
    ).toThrow("malformed shipped baseline exclusion");
    expect(() =>
      parseShippedBaselineExclusions("Shipped baseline exclusions: v2026.6.11 (2 PRs: #101)."),
    ).toThrow("invalid shipped baseline exclusion count");
  });

  it("rejects tag/version drift and legacy oversized ledger anchors", () => {
    expect(() =>
      renderGithubReleaseNotes({
        changelog: changelogFor("- **PR #123** fix: example."),
        version,
        tag: "v2026.7.2-beta.1",
        repository,
      }),
    ).toThrow("requires CHANGELOG.md version 2026.7.2");

    expect(() =>
      renderGithubReleaseNotes({
        changelog: changelogFor(
          `### Complete contribution ledger\n\n${"legacy ".repeat(20_000)}`,
        ).replace("### Complete contribution record\n\n", ""),
        version,
        tag,
        repository,
      }),
    ).toThrow("cannot be compacted without a complete contribution record");
  });

  it("prefers an alpha tag's exact changelog heading over the Unreleased fallback", () => {
    // Shipped alpha tags carry their own heading with no base section,
    // matching the tagged CHANGELOG.md shape of v2026.6.20-alpha.1.
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1-alpha.2",
      "",
      "- Alpha-only fix.",
      "",
      "## 2026.6.11",
      "",
      "- Previous release.",
      "",
    ].join("\n");
    const rendered = renderGithubReleaseNotes({
      changelog,
      version,
      tag: "v2026.7.1-alpha.2",
      repository,
    });

    expect(rendered.body).toContain("## 2026.7.1-alpha.2");
    expect(rendered.body).toContain("Alpha-only fix.");
    expect(rendered.body).not.toContain("Previous release.");
  });

  it("permits the Unreleased fallback only for alpha tags", () => {
    const changelog = changelogFor("- **PR #123** fix: example.").replace(
      "## 2026.7.1",
      "## Unreleased",
    );
    const rendered = renderGithubReleaseNotes({
      changelog,
      version,
      tag: "v2026.7.1-alpha.1",
      repository,
    });

    expect(rendered.body).toContain("## 2026.7.1");
    expect(rendered.body).not.toContain("## Unreleased");
    expect(() =>
      renderGithubReleaseNotes({
        changelog,
        version,
        tag,
        repository,
      }),
    ).toThrow("CHANGELOG.md does not contain ## 2026.7.1");
    expect(() =>
      renderGithubReleaseNotes({
        changelog,
        version: "foo",
        tag: "vfoo-alpha.1",
        repository,
      }),
    ).toThrow("invalid release tag");
  });

  it("ignores fenced pseudo-headings and handles a release heading at EOF", () => {
    const fenced = [
      `## ${version}`,
      "",
      "```md",
      "## 2099.1.1",
      "```",
      "",
      "### Fixes",
      "",
      "- Still in the current release.",
      "",
      "## 2026.6.11",
    ].join("\n");

    expect(extractChangelogSection(fenced, version)).toContain("- Still in the current release.");
    expect(extractChangelogSection(`## ${version}`, version)).toBe(`## ${version}`);
  });

  it("compacts at the real contribution record instead of a fenced pseudo-heading", () => {
    const changelog = changelogFor(`- **PR #123** ${"record-only-detail ".repeat(9_000)}`).replace(
      "### Fixes",
      ["```md", "### Complete contribution record", "```", "", "### Fixes"].join("\n"),
    );
    const rendered = renderGithubReleaseNotes({ changelog, version, tag, repository });

    expect(rendered.mode).toBe("compact");
    expect(rendered.body).toContain("```md\n### Complete contribution record\n```");
    expect(rendered.body).toContain("- A grouped user-facing fix.");
    expect(rendered.body).not.toContain("record-only-detail");
  });

  it("verifies the exact generated compact body and optional proof tail", () => {
    const changelog = changelogFor(`- **PR #123** ${"z".repeat(130_000)}`);
    const verification = "### Release verification\n\n- release SHA: `abc123`";
    const rendered = renderGithubReleaseNotes({
      changelog,
      version,
      tag,
      repository,
      verification,
    });

    expect(
      verifyGithubReleaseNotes({
        body: rendered.body,
        changelog,
        version,
        tag,
        repository,
      }),
    ).toMatchObject({ matches: true, mode: "compact" });
    expect(
      verifyGithubReleaseNotes({
        body: rendered.body.replace("tag-pinned", "mutable"),
        changelog,
        version,
        tag,
        repository,
      }).matches,
    ).toBe(false);
    expect(
      verifyGithubReleaseNotes({
        body: rendered.body,
        changelog,
        version,
        tag: "v2026.7.1-beta.2",
        repository,
      }).matches,
    ).toBe(false);
  });

  it("does not treat fenced verification headings as appended proof", () => {
    const changelog = changelogFor(
      [
        "```md",
        "### Release verification",
        "",
        "- Example only.",
        "```",
        "",
        "- **PR #123** fix: example.",
      ].join("\n"),
    );
    const rendered = renderGithubReleaseNotes({ changelog, version, tag, repository });

    expect(
      verifyGithubReleaseNotes({
        body: rendered.body,
        changelog,
        version,
        tag,
        repository,
      }),
    ).toMatchObject({ matches: true, verificationIncluded: false });
  });
});
