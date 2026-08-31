// Docs link audit tests cover documentation link validation behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const {
  normalizeRoute,
  prepareAnchorAuditDocsDir,
  prepareExternalLinkAuditTree,
  prepareMirroredDocsDir,
  resolveRoute,
  runDocsLinkAuditCli,
  sanitizeDocsConfigForEnglishOnly,
} = await import("../../scripts/docs-link-audit.mts");

describe("docs-link-audit", () => {
  function tempEntries(prefix: string): Set<string> {
    return new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix)));
  }

  it("normalizes route fragments away", () => {
    expect(normalizeRoute("/plugins/building-plugins#registering-agent-tools")).toBe(
      "/plugins/building-plugins",
    );
    expect(normalizeRoute("/plugins/building-plugins?tab=all")).toBe("/plugins/building-plugins");
  });

  it("prepares every external-link input without exposing code literals", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-external-link-audit-");
    const docsRoot = path.join(fixtureRoot, "docs");
    const source = [
      "<AccordionGroup>",
      '  <Accordion title="Reasoning">',
      "    [reasoning](https://docs.example.test/reasoning)",
      "    `https://api.example.test/v1`",
      "    ````markdown",
      "    ```text",
      "    <CODE_PLACEHOLDER>",
      "    ```",
      "    ~~~",
      "    [code literal](https://code.example.test)",
      "    ~~~",
      "    ````",
      "    - ```html",
      '      <script src="https://code.example.test/list-fence">',
      "      ```",
      "      [after list fence](https://docs.example.test/after-list-fence)",
      "    ```text",
      "    - ```",
      "    <Accordion>",
      "    [fenced component](https://code.example.test/fenced-component)",
      "    ```",
      "    [after literal list fence](https://docs.example.test/after-literal-list-fence)",
      "  </Accordion>",
      "</AccordionGroup>",
      "<Link>",
      "    [component link](https://docs.example.test/component)",
      "</Link>",
      "<Pre>",
      "    [pre component](https://docs.example.test/pre-component)",
      "</Pre>",
      "[after code block](https://docs.example.test/after-code-block)",
      "[after indented code](https://docs.example.test/after-indented-code)",
      "[after script](https://docs.example.test/after-script)",
      "[after void](https://docs.example.test/after-void)",
      "[reference][shared]",
      "",
      "[shared]: https://docs.example.test/reference-first?one=1&two=2",
      "[shared]: https://docs.example.test/reference-second",
      "![image](https://docs.example.test/image.png?one=1&two=2)",
      "`<PROVIDER>_API_KEY=...`",
      "",
    ].join("\n");
    fs.mkdirSync(path.join(docsRoot, "providers"), { recursive: true });
    fs.writeFileSync(path.join(docsRoot, "providers", "example.md"), source, "utf8");
    for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
      fs.writeFileSync(
        path.join(fixtureRoot, filename),
        `<div>\n  [${filename}](https://root.test)\n</div>\n`,
      );
    }

    try {
      const outputRoot = path.join(fixtureRoot, ".audit");
      expect(prepareExternalLinkAuditTree(fixtureRoot, outputRoot)).toEqual({
        files: 4,
        projectedLinks: 14,
      });
      const prepared = fs.readFileSync(
        path.join(outputRoot, "docs", "providers", "example.md"),
        "utf8",
      );
      const preparedLines = prepared.split("\n");
      expect(preparedLines).toHaveLength(source.split("\n").length);
      expect(preparedLines[2]).toContain('href="https://docs.example.test/reasoning"');
      for (const url of [
        "https://docs.example.test/after-list-fence",
        "https://docs.example.test/after-literal-list-fence",
        "https://docs.example.test/component",
        "https://docs.example.test/pre-component",
        "https://docs.example.test/after-code-block",
        "https://docs.example.test/after-indented-code",
        "https://docs.example.test/after-script",
        "https://docs.example.test/after-void",
      ]) {
        expect(prepared).toContain(`href="${url}"`);
      }
      expect(prepared).toContain(
        'href="https://docs.example.test/reference-first?one=1&amp;two=2"',
      );
      expect(prepared).toContain('href="https://docs.example.test/image.png?one=1&amp;two=2"');
      for (const url of [
        "https://api.example.test/v1",
        "https://code.example.test",
        "https://code.example.test/inline",
        "https://code.example.test/list-fence",
        "https://code.example.test/fenced-component",
        "https://code.example.test/unclosed",
        "https://code.example.test/still-hidden",
        "https://code.example.test/pre",
        "https://code.example.test/script",
        "https://code.example.test/script-body",
        "https://docs.example.test/reference-second",
      ]) {
        expect(prepared).not.toContain(url);
      }
      for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
        expect(fs.readFileSync(path.join(outputRoot, filename), "utf8")).toContain(
          'href="https://root.test"',
        );
      }
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("falls back to tolerant parsing for legacy malformed MDX", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-external-link-fallback-");
    fs.mkdirSync(path.join(fixtureRoot, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, "docs", "legacy.md"),
      "<!doctype html>\n<pre>\n[hidden](https://hidden.example.test)\n</pre>\n<Note>\ntext <code>[inline hidden](https://same.example.test)</code> [inline real](https://same.example.test)\n[legacy](https://legacy.example.test)\n</Note>\n<Pre>\n[component](https://component.example.test)\n</Pre>\n[reference][legacy-ref]\n\n[legacy-ref]: https://reference.example.test\n<style><code>[style hidden](https://style.example.test)</code></style> [style real](https://style.example.test)\n```html\n<code>\n[fenced hidden](https://fenced-hidden.example.test)\n```\n<Note>\n[after fence](https://after-fence.example.test)\n</Note>\n",
    );
    for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
      fs.writeFileSync(path.join(fixtureRoot, filename), "");
    }

    try {
      const outputRoot = path.join(fixtureRoot, ".audit");
      expect(prepareExternalLinkAuditTree(fixtureRoot, outputRoot)).toEqual({
        files: 4,
        projectedLinks: 6,
      });
      const prepared = fs
        .readFileSync(path.join(outputRoot, "docs", "legacy.md"), "utf8")
        .split("\n");
      expect(prepared[6]).toContain('href="https://legacy.example.test"');
      expect(prepared[5]?.match(/https:\/\/same\.example\.test/g)).toHaveLength(1);
      expect(prepared[9]).toContain('href="https://component.example.test"');
      expect(prepared[11]).toContain('href="https://reference.example.test"');
      expect(prepared[14]?.match(/https:\/\/style\.example\.test/g)).toHaveLength(1);
      expect(prepared[20]).toContain('href="https://after-fence.example.test"');
      expect(prepared.join("\n")).not.toContain("https://hidden.example.test");
      expect(prepared.join("\n")).not.toContain("https://fenced-hidden.example.test");
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("resolves redirects that land on anchored sections", () => {
    const redirects = new Map([
      ["/plugins/agent-tools", "/plugins/building-plugins#registering-agent-tools"],
    ]);
    const routes = new Set(["/plugins/building-plugins"]);

    expect(resolveRoute("/plugins/agent-tools", { redirects, routes })).toEqual({
      ok: true,
      terminal: "/plugins/building-plugins",
    });
  });

  it("sanitizes docs.json to English-only route targets", () => {
    expect(
      sanitizeDocsConfigForEnglishOnly({
        navigation: [
          {
            language: "en",
            tabs: [
              {
                tab: "Docs",
                groups: [
                  {
                    group: "Keep",
                    pages: ["help/testing", "zh-CN/help/testing", "ja-JP/help/testing"],
                  },
                ],
              },
            ],
          },
          {
            language: "zh-Hans",
            tabs: [{ tab: "中文", groups: [{ group: "帮助", pages: ["zh-CN/help/testing"] }] }],
          },
        ],
        redirects: [
          { source: "/help/testing", destination: "/help/testing" },
          { source: "/zh-CN/help/testing", destination: "/help/testing" },
          { source: "/help/testing", destination: "/ja-JP/help/testing" },
        ],
      }),
    ).toEqual({
      navigation: [
        {
          language: "en",
          tabs: [
            {
              tab: "Docs",
              groups: [{ group: "Keep", pages: ["help/testing"] }],
            },
          ],
        },
      ],
      redirects: [{ source: "/help/testing", destination: "/help/testing" }],
    });
  });

  it("builds an English-only docs tree for anchor audits", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-fixture-");
    const docsRoot = path.join(fixtureRoot, "docs");
    fs.mkdirSync(path.join(docsRoot, "help"), { recursive: true });
    fs.mkdirSync(path.join(docsRoot, "zh-CN", "help"), { recursive: true });
    fs.writeFileSync(
      path.join(docsRoot, "docs.json"),
      `${JSON.stringify(
        {
          navigation: [
            {
              language: "en",
              tabs: [{ tab: "Docs", groups: [{ group: "Help", pages: ["help/testing"] }] }],
            },
            {
              language: "zh-Hans",
              tabs: [{ tab: "中文", groups: [{ group: "帮助", pages: ["zh-CN/help/testing"] }] }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(docsRoot, "help", "testing.md"),
      [
        "# testing",
        "<!-- BEGIN GENERATED: example -->",
        "visible <!-- a multiline",
        "comment --> text",
        "<!-- END GENERATED: example -->",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(docsRoot, "zh-CN", "help", "testing.md"), "# 测试\n", "utf8");

    const anchorDocsDir = prepareAnchorAuditDocsDir(docsRoot);
    try {
      expect(fs.existsSync(path.join(anchorDocsDir, "help", "testing.md"))).toBe(true);
      expect(fs.existsSync(path.join(anchorDocsDir, "zh-CN"))).toBe(false);
      const preparedMarkdown = fs.readFileSync(
        path.join(anchorDocsDir, "help", "testing.md"),
        "utf8",
      );
      expect(preparedMarkdown).not.toContain("<!--");
      expect(preparedMarkdown).not.toContain("BEGIN GENERATED");
      expect(preparedMarkdown.split("\n")).toHaveLength(6);

      const sanitizedDocsJson = JSON.parse(
        fs.readFileSync(path.join(anchorDocsDir, "docs.json"), "utf8"),
      );
      expect(sanitizedDocsJson).toEqual({
        navigation: [
          {
            language: "en",
            tabs: [{ tab: "Docs", groups: [{ group: "Help", pages: ["help/testing"] }] }],
          },
        ],
      });
    } finally {
      fs.rmSync(anchorDocsDir, { recursive: true, force: true });
      cleanupTempDirs(tempDirs);
    }
  });

  it("cleans anchor audit docs copies when docs.json is invalid", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-invalid-");
    const docsRoot = path.join(fixtureRoot, "docs");
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(path.join(docsRoot, "docs.json"), "{ invalid json", "utf8");

    const before = tempEntries("openclaw-docs-anchor-audit-");
    try {
      expect(() => prepareAnchorAuditDocsDir(docsRoot)).toThrow();
      const after = tempEntries("openclaw-docs-anchor-audit-");
      expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("does not create mirrored docs copies for non-root docs trees", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-mirror-");
    const docsRoot = path.join(fixtureRoot, "docs");
    fs.mkdirSync(docsRoot, { recursive: true });

    const before = tempEntries("openclaw-docs-link-audit-");
    try {
      const mirroredDocsDir = prepareMirroredDocsDir(docsRoot);
      expect(mirroredDocsDir).toEqual({
        cleanup: expect.any(Function),
        dir: path.resolve(docsRoot),
        mirroredClawHub: false,
      });
      mirroredDocsDir.cleanup();
      const after = tempEntries("openclaw-docs-link-audit-");
      expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("cleans mirrored docs copies when ClawHub sync fails", () => {
    const before = tempEntries("openclaw-docs-link-audit-");

    expect(() =>
      prepareMirroredDocsDir(undefined, {
        resolveClawHubRepoPathImpl() {
          return path.join(os.tmpdir(), "clawhub-docs");
        },
        syncClawHubDocsTreeImpl() {
          throw new Error("sync failed");
        },
      }),
    ).toThrow("sync failed");

    const after = tempEntries("openclaw-docs-link-audit-");
    expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
  });

  it("cleans mirrored docs copies when anchor prep fails", () => {
    let mirroredCleaned = false;

    expect(() =>
      runDocsLinkAuditCli({
        args: ["--anchors"],
        cleanupAnchorAuditDocsDirImpl() {
          throw new Error("anchor cleanup should not run");
        },
        prepareAnchorAuditDocsDirImpl() {
          throw new Error("anchor prep failed");
        },
        prepareMirroredDocsDirImpl: () => ({
          cleanup() {
            mirroredCleaned = true;
          },
          dir: path.join(os.tmpdir(), "openclaw-docs-mirrored"),
          mirroredClawHub: true,
        }),
      }),
    ).toThrow("anchor prep failed");
    expect(mirroredCleaned).toBe(true);
  });

  it("uses a pinned Mintlify package through npm for anchor validation", () => {
    let invocation:
      | {
          command: string;
          args: string[];
          options: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; stdio: string };
        }
      | undefined;
    let cleanedDir: string | undefined;
    const anchorDocsDir = path.join(os.tmpdir(), "docs-link-audit-anchor");
    fs.mkdirSync(anchorDocsDir, { recursive: true });

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      env: { ...process.env, OPENCLAW_DOCS_LINK_SENTINEL: "1" },
      nodeExecPath: "/opt/node/bin/node",
      nodeVersion: "22.21.1",
      prepareAnchorAuditDocsDirImpl() {
        return anchorDocsDir;
      },
      cleanupAnchorAuditDocsDirImpl(dir) {
        cleanedDir = dir;
      },
      spawnSyncImpl(command, args, options) {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(invocation).toEqual({
      command: "npm",
      args: [
        "exec",
        "--yes",
        "--package=mint@4.2.808",
        "--",
        "mint",
        "broken-links",
        "--check-anchors",
      ],
      options: expect.objectContaining({
        cwd: anchorDocsDir,
        env: expect.objectContaining({ OPENCLAW_DOCS_LINK_SENTINEL: "1" }),
        shell: false,
        stdio: "inherit",
      }),
    });
    expect(cleanedDir).toBe(anchorDocsDir);
  });

  it("wraps Mintlify with Node 22 when the current Node is too new", () => {
    const invocations: Array<{
      command: string;
      args: string[];
      options: { cwd: string; stdio: string };
    }> = [];
    let cleanedDir: string | undefined;
    const anchorDocsDir = path.join(os.tmpdir(), "docs-link-audit-anchor");
    fs.mkdirSync(anchorDocsDir, { recursive: true });

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      nodeExecPath: "/opt/node/bin/node",
      nodeVersion: "25.3.0",
      prepareAnchorAuditDocsDirImpl() {
        return anchorDocsDir;
      },
      cleanupAnchorAuditDocsDirImpl(dir) {
        cleanedDir = dir;
      },
      spawnSyncImpl(command, args, options) {
        invocations.push({ command, args, options });
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(invocations).toHaveLength(2);
    const [versionCheck, linkCheck] = invocations;
    if (!versionCheck || !linkCheck) {
      throw new Error("Expected Mintlify wrapper invocations");
    }
    expect(versionCheck).toEqual({
      command: "fnm",
      args: [
        "exec",
        "--using=22",
        "node",
        "-e",
        "process.exit(Number(process.versions.node.split('.')[0]) === 22 ? 0 : 1)",
      ],
      options: { cwd: anchorDocsDir, stdio: "ignore" },
    });
    expect(linkCheck).toEqual({
      command: "fnm",
      args: [
        "exec",
        "--using=22",
        "npm",
        "exec",
        "--yes",
        "--package=mint@4.2.808",
        "--",
        "mint",
        "broken-links",
        "--check-anchors",
      ],
      options: { cwd: anchorDocsDir, stdio: "inherit" },
    });
    expect(cleanedDir).toBe(anchorDocsDir);
  });
});
