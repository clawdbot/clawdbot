import { describe, expect, it } from "vitest";
import {
  appendGitHubReleaseVerification,
  GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS,
  GITHUB_RELEASE_VERIFICATION_RESERVE_UTF8_BYTES,
  MAX_GITHUB_RELEASE_NOTES_CHARACTERS,
  MAX_GITHUB_RELEASE_NOTES_UTF8_BYTES,
  MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS,
  MAX_GITHUB_RELEASE_SOURCE_NOTES_UTF8_BYTES,
  prepareGitHubReleaseNotes,
} from "../../scripts/prepare-github-release-notes.mjs";

describe("prepareGitHubReleaseNotes", () => {
  it("preserves the stable-base heading for prerelease notes", () => {
    const changelog = [
      "## Unreleased",
      "",
      "Future work.",
      "",
      "## 2026.7.1",
      "",
      "Release work.",
      "",
      "## 2026.6.11",
      "",
      "Older work.",
    ].join("\n");

    expect(prepareGitHubReleaseNotes(changelog, "v2026.7.1-beta.3")).toBe(
      "## 2026.7.1\n\nRelease work.\n",
    );
  });

  it("uses an exact alpha heading before the Unreleased fallback", () => {
    const changelog = [
      "## Unreleased",
      "",
      "Future nightly work.",
      "",
      "## 2026.7.2-alpha.3",
      "",
      "Nightly release work.",
      "",
      "## 2026.7.1",
      "",
      "Stable work.",
    ].join("\n");

    expect(prepareGitHubReleaseNotes(changelog, "v2026.7.2-alpha.3")).toBe(
      "## 2026.7.2-alpha.3\n\nNightly release work.\n",
    );
  });

  it("keeps the Unreleased fallback for alpha branches without an exact heading", () => {
    const changelog = "## Unreleased\n\nNightly release work.\n\n## 2026.7.1\n\nStable work.\n";

    expect(prepareGitHubReleaseNotes(changelog, "v2026.7.2-alpha.3")).toBe(
      "## Unreleased\n\nNightly release work.\n",
    );
  });

  it("prefers an exact numeric correction heading", () => {
    const changelog = [
      "## 2026.7.1-2",
      "",
      "Correction-specific work.",
      "",
      "## 2026.7.1",
      "",
      "Base release work.",
    ].join("\n");

    expect(prepareGitHubReleaseNotes(changelog, "v2026.7.1-2")).toBe(
      "## 2026.7.1-2\n\nCorrection-specific work.\n",
    );
  });

  it("falls back to the base heading for numeric correction tags", () => {
    const changelog = "## 2026.7.1\n\nBase release work.\n\n## 2026.6.11\n\nOlder work.\n";

    expect(prepareGitHubReleaseNotes(changelog, "v2026.7.1-2")).toBe(
      "## 2026.7.1\n\nBase release work.\n",
    );
  });

  it("requires the stable-base section for beta and stable releases", () => {
    const changelog = "## Unreleased\n\nCandidate work.\n\n## 2026.6.11\n\nOlder work.\n";

    expect(() => prepareGitHubReleaseNotes(changelog, "v2026.7.1-beta.3")).toThrow(
      "does not contain release notes for 2026.7.1",
    );
    expect(() => prepareGitHubReleaseNotes(changelog, "v2026.7.1")).toThrow(
      "does not contain release notes for 2026.7.1",
    );
  });

  it("rejects a heading without release-note content", () => {
    const changelog = "## 2026.7.1\n\n## 2026.6.11\n\nOlder work.\n";

    expect(() => prepareGitHubReleaseNotes(changelog, "v2026.7.1-beta.3")).toThrow(
      "does not contain release-note content",
    );
  });

  it("accepts multibyte source sections below the character and byte budgets", () => {
    const changelog = `## 2026.7.1\n\n${"é".repeat(59_000)}\n`;

    expect(prepareGitHubReleaseNotes(changelog, "v2026.7.1-beta.3")).toHaveLength(59_014);
  });

  it("rejects multibyte source sections that exceed the UTF-8 byte budget", () => {
    const changelog = `## 2026.7.1\n\n${"é".repeat(70_000)}\n`;

    expect(() => prepareGitHubReleaseNotes(changelog, "v2026.7.1-beta.3")).toThrow(
      `complete source section exceeds the ${MAX_GITHUB_RELEASE_SOURCE_NOTES_UTF8_BYTES}-byte source safety budget`,
    );
  });

  it("accepts a source body exactly at the proof-reserving limit", () => {
    const prefix = "## 2026.7.1\n\n";
    const content = "x".repeat(MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS - prefix.length - 1);

    expect(prepareGitHubReleaseNotes(`${prefix}${content}\n`, "v2026.7.1-beta.3")).toHaveLength(
      MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS,
    );
  });

  it("rejects source sections that consume the required proof reserve", () => {
    const prefix = "## 2026.7.1\n\n";
    const content = "x".repeat(MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS - prefix.length);
    const changelog = `${prefix}${content}\n`;

    expect(() => prepareGitHubReleaseNotes(changelog, "v2026.7.1-beta.3")).toThrow(
      "complete source section exceeds the 120000-character source budget",
    );
  });

  it("appends and replaces canonical release verification within the reserve", () => {
    const notes = "## 2026.7.1\n\nRelease work.\n\n### Release verification\n\n- stale proof\n";
    const proof = "### Release verification\n\n- current proof";

    expect(appendGitHubReleaseVerification(notes, proof)).toBe(
      "## 2026.7.1\n\nRelease work.\n\n### Release verification\n\n- current proof\n",
    );
  });

  it("rejects proof that exceeds its reserved capacity", () => {
    const proof = `### Release verification\n\n${"x".repeat(
      GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS,
    )}`;

    expect(() => appendGitHubReleaseVerification("## 2026.7.1\n\nRelease work.\n", proof)).toThrow(
      "exceeds the reserved 5000-character budget",
    );
  });

  it("rejects multibyte proof that exceeds its reserved byte capacity", () => {
    const proof = `### Release verification\n\n${"é".repeat(
      GITHUB_RELEASE_VERIFICATION_RESERVE_UTF8_BYTES / 2,
    )}`;

    expect(() => appendGitHubReleaseVerification("## 2026.7.1\n\nRelease work.\n", proof)).toThrow(
      "exceeds the reserved 5000-byte safety budget",
    );
  });

  it("keeps the combined body under GitHub's hard limit", () => {
    const prefix = "## 2026.7.1\n\n";
    const content = "x".repeat(MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS - prefix.length - 1);
    const notes = prepareGitHubReleaseNotes(`${prefix}${content}\n`, "v2026.7.1");
    const proof = `### Release verification\n\n${"x".repeat(
      GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS - 40,
    )}`;

    expect(appendGitHubReleaseVerification(notes, proof).length).toBeLessThanOrEqual(
      MAX_GITHUB_RELEASE_NOTES_CHARACTERS,
    );
    expect(
      Buffer.byteLength(appendGitHubReleaseVerification(notes, proof), "utf8"),
    ).toBeLessThanOrEqual(MAX_GITHUB_RELEASE_NOTES_UTF8_BYTES);
  });
});
