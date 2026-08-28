// docs-list tests cover source docs metadata discovery for docs-aware tooling.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderDocsHeadingMap } from "../../scripts/docs-list.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../..");
const docsListScriptPath = path.join(repoRoot, "scripts", "docs-list.js");

function makeTempRepoRoot(prefix: string): string {
  return makeTempDir(tempDirs, prefix);
}

function runDocsList(cwd: string, args: string[] = []): string {
  return execFileSync(process.execPath, [docsListScriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("docs-list", () => {
  it("reports a concise error outside a source checkout", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-list-missing-");
    const result = spawnSync(process.execPath, [docsListScriptPath], {
      cwd: tempRepoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("docs:list: missing docs directory. Run from repo root.\n");
  });

  it("prints single-line read_when strings as read hints", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-list-");
    mkdirSync(path.join(tempRepoRoot, "docs"), { recursive: true });
    writeFileSync(
      path.join(tempRepoRoot, "docs", "page.md"),
      `---
summary: "Single-line read_when page"
read_when: "Read this page when the hint is inline."
---
`,
      "utf8",
    );

    const output = runDocsList(tempRepoRoot);

    expect(output).toContain("page.md - Single-line read_when page");
    expect(output).toContain("Read when: Read this page when the hint is inline.");
  });

  it("accepts YAML document end markers in front matter", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-list-yaml-end-");
    mkdirSync(path.join(tempRepoRoot, "docs"), { recursive: true });
    writeFileSync(
      path.join(tempRepoRoot, "docs", "page.md"),
      `---
summary: "YAML document end page"
...
`,
      "utf8",
    );

    const output = runDocsList(tempRepoRoot);

    expect(output).toContain("page.md - YAML document end page");
    expect(output).not.toContain("unterminated front matter");
  });

  it("preserves suffixes and line endings on front matter terminators", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-list-terminator-suffixes-");
    mkdirSync(path.join(tempRepoRoot, "docs"), { recursive: true });
    const cases = [
      [
        "annotated.md",
        '---\r\nsummary: "Annotated closing delimiter"\r\n--- # end\r\n',
        "Annotated closing delimiter",
      ],
      [
        "whitespace.md",
        '---\nsummary: "Whitespace closing delimiter"\n---   \n',
        "Whitespace closing delimiter",
      ],
      [
        "document-end-comment.md",
        '---\r\nsummary: "Document end comment"\r\n... # end\r\n',
        "Document end comment",
      ],
    ] as const;

    for (const [fileName, content] of cases) {
      writeFileSync(path.join(tempRepoRoot, "docs", fileName), content, "utf8");
    }

    const output = runDocsList(tempRepoRoot);

    for (const [fileName, , summary] of cases) {
      expect(output).toContain(`${fileName} - ${summary}`);
    }
    expect(output).not.toContain("unterminated front matter");
  });

  it("renders the publish docs map on demand without creating a mirror", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-headings-");
    mkdirSync(path.join(tempRepoRoot, "docs", "nested"), { recursive: true });
    writeFileSync(
      path.join(tempRepoRoot, "docs", "page.md"),
      `---
summary: "Page"
---
# Visible title

## \`API[*]\` <script>alert(1)</script>

### <scr<script>ipt>alert(1)</script>

#### \`![label](https://example.test/image)\`

\`\`\`md
### Hidden fenced heading
\`\`\`
`,
      "utf8",
    );
    writeFileSync(path.join(tempRepoRoot, "docs", "nested", "index.mdx"), "# Nested\n");
    writeFileSync(path.join(tempRepoRoot, "docs", "AGENTS.md"), "# Instructions\n");

    const output = runDocsList(tempRepoRoot, ["--headings"]);

    expect(output).toContain("## page.md\n\n- Route: /page");
    expect(output).toContain("  - H1: Visible title");
    expect(output).toContain("  - H2: `API[*]` &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(output).toContain("  - H3: &lt;scr&lt;script&gt;ipt&gt;alert(1)&lt;/script&gt;");
    expect(output).toContain("  - H4: `![label](https://example.test/image)`");
    expect(output).toContain("## nested/index.mdx\n\n- Route: /nested");
    expect(output).not.toContain("Hidden fenced heading");
    expect(output).not.toContain("AGENTS.md");
    expect(existsSync(path.join(tempRepoRoot, "docs", "docs_map.md"))).toBe(false);
  });

  it("strips annotated front matter terminators from the docs map", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-headings-frontmatter-");
    const docsDir = path.join(tempRepoRoot, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      path.join(docsDir, "page.md"),
      `---
summary: "Annotated page"
# This metadata comment must not become a heading
... # end
# Visible title
`,
      "utf8",
    );

    const output = runDocsList(tempRepoRoot, ["--headings"]);

    expect(output).toContain("  - H1: Visible title");
    expect(output).not.toContain("metadata comment must not become a heading");
  });

  it("normalizes injected Windows paths for nested page routes", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-headings-windows-");
    const docsDir = path.join(tempRepoRoot, "docs");
    mkdirSync(path.join(docsDir, "nested"), { recursive: true });
    writeFileSync(path.join(docsDir, "nested", "index.mdx"), "# Nested index\n");
    writeFileSync(path.join(docsDir, "nested", "page.md"), "# Nested page\n");

    const output = renderDocsHeadingMap(docsDir, {
      relativePath: (base, fullPath) => path.relative(base, fullPath).replace(/[\\/]+/gu, "\\"),
    });

    expect(output).toContain("## nested/index.mdx\n\n- Route: /nested");
    expect(output).toContain("## nested/page.md\n\n- Route: /nested/page");
    expect(output).not.toContain("\\");
  });
});
