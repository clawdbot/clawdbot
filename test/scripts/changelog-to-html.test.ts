import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const footer =
  '<p><a href="https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md">View full changelog</a></p>';

function render(section: string, version = "2026.8.2") {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-changelog-html-"));
  roots.push(root);
  const file = path.join(root, "CHANGELOG.md");
  writeFileSync(file, section);
  return spawnSync("bash", ["scripts/changelog-to-html.sh", version, file], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("changelog release HTML", () => {
  it("preserves markup ordering, literal HTML, links, backslashes and list boundaries", () => {
    const result = render(
      [
        "# Changelog",
        "## 2026.8.2 (Unreleased)",
        "",
        "### Highlights",
        "- **Fast** & reliable `path\\file`",
        "- [Guide](https://example.com?a=1&b=2) and **bold**",
        "",
        "#### Details",
        "<p>Existing &amp; HTML</p>",
        "##### More",
        "- Plain <tag>",
        "## 2026.8.1",
        "- Old release",
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        "<h2>OpenClaw 2026.8.2</h2>",
        "<h3>Highlights</h3>",
        "<ul>",
        "<li><strong>Fast</strong> & reliable <code>path\\file</code></li>",
        '<li><a href="https://example.com?a=1&b=2">Guide</a> and <strong>bold</strong></li>',
        "</ul>",
        "<h4>Details</h4>",
        "<p>Existing &amp; HTML</p>",
        "<h5>More</h5>",
        "<ul>",
        "<li>Plain <tag></li>",
        "</ul>",
        footer,
        "",
      ].join("\n"),
    );
  });

  it("renders a release-sized appendix within the command budget without losing entries", () => {
    const entries = Array.from(
      { length: 2_000 },
      (_, index) =>
        `- **Fix ${index}**: preserve \`bytes\` & [credit](https://example.com/${index})`,
    );
    const result = render(`## 2026.8.2\n\n### Contributions\n${entries.join("\n")}\n`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        "<h2>OpenClaw 2026.8.2</h2>",
        "<h3>Contributions</h3>",
        "<ul>",
        ...entries.map(
          (_, index) =>
            `<li><strong>Fix ${index}</strong>: preserve <code>bytes</code> & <a href="https://example.com/${index}">credit</a></li>`,
        ),
        "</ul>",
        footer,
        "",
      ].join("\n"),
    );
  });

  it("keeps the missing-version fallback", () => {
    const result = render("## 2026.8.1\n- Previous release\n");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `<h2>OpenClaw 2026.8.2</h2>\n<p>Latest OpenClaw update.</p>\n${footer}\n`,
    );
  });
});
