// Docs i18n tests cover the Go module and behavior fixtures backing docs translation.
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const hasGoToolchain = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasGoToolchain)("docs-i18n Go module", () => {
  let binaryPath = "";
  let cliBinaryPath = "";
  let translatorStubPath = "";
  let tempDir = "";

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-docs-i18n-test-"));
    binaryPath = path.join(
      tempDir,
      process.platform === "win32" ? "docs-i18n.test.exe" : "docs-i18n.test",
    );
    cliBinaryPath = path.join(
      tempDir,
      process.platform === "win32" ? "docs-i18n.exe" : "docs-i18n",
    );
    const translatorModulePath = path.join(tempDir, "codex-stub.mjs");
    translatorStubPath = path.join(
      tempDir,
      process.platform === "win32" ? "codex-stub.cmd" : "codex-stub",
    );
    writeFileSync(
      translatorModulePath,
      `import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0 || !args[outputIndex + 1]) {
  throw new Error("missing output path");
}
const input = readFileSync(0, "utf8");
const startToken = "<openclaw_docs_i18n_input>\\n";
const endToken = "\\n</openclaw_docs_i18n_input>";
const start = input.indexOf(startToken);
const end = input.indexOf(endToken, start + startToken.length);
if (start < 0 || end < 0) {
  throw new Error("missing translation payload");
}
writeFileSync(args[outputIndex + 1], input.slice(start + startToken.length, end).trim());
`,
      "utf8",
    );
    if (process.platform === "win32") {
      writeFileSync(
        translatorStubPath,
        `@echo off\r\n"${process.execPath}" "%~dp0codex-stub.mjs" %*\r\n`,
        "utf8",
      );
    } else {
      writeFileSync(
        translatorStubPath,
        `#!/usr/bin/env bash\nexec "${process.execPath}" "$(dirname "$0")/codex-stub.mjs" "$@"\n`,
        "utf8",
      );
      chmodSync(translatorStubPath, 0o755);
    }
    const result = spawnSync("go", ["test", "-modcacherw", "-c", "-o", binaryPath, "."], {
      cwd: "scripts/docs-i18n",
      encoding: "utf8",
      // Go's default read-only module directories prevent recursive teardown.
      // Keep this build's writable module cache inside the suite-owned root.
      env: {
        ...process.env,
        GOMODCACHE: path.join(tempDir, "gomodcache"),
        GOTOOLCHAIN: "local",
      },
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || result.stdout || "failed to build Go tests");
    }
    const cliResult = spawnSync("go", ["build", "-o", cliBinaryPath, "."], {
      cwd: "scripts/docs-i18n",
      encoding: "utf8",
      env: {
        ...process.env,
        GOMODCACHE: path.join(tempDir, "gomodcache"),
        GOTOOLCHAIN: "local",
      },
    });
    if (cliResult.error || cliResult.status !== 0) {
      throw (
        cliResult.error ??
        new Error(cliResult.stderr || cliResult.stdout || "failed to build Go CLI")
      );
    }
  });

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.concurrent.each([
    ["A-F", "^Test[A-F]"],
    ["G-L", "^Test[G-L]"],
    ["M-R", "^Test[M-R]"],
    ["S-Z", "^Test[S-Z]"],
  ])("passes Go tests in the %s partition", async (partition, pattern) => {
    const { stdout } = await execFileAsync(binaryPath, ["-test.count=1", `-test.run=${pattern}`], {
      cwd: "scripts/docs-i18n",
      encoding: "utf8",
      // The user cache can be under /tmp when the test invocation owns it.
      env: { ...process.env, XDG_CACHE_HOME: path.join(tempDir, "cache", partition) },
    });
    if (stdout.trim()) {
      console.log(stdout.trim());
    }
  });

  it("runs the docs-i18n CLI and preserves YAML document-end front matter", () => {
    const docsRoot = mkdtempSync(path.join(tempDir, "cli-fixture-"));
    mkdirSync(path.join(docsRoot, ".i18n"));
    writeFileSync(path.join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]");
    writeFileSync(path.join(docsRoot, "docs.json"), '{"redirects":[]}');
    const sourcePath = path.join(docsRoot, "guide.md");
    writeFileSync(
      sourcePath,
      [
        "---",
        "title: Gateway",
        "description: |",
        "  ...",
        "  retained scalar content",
        "...",
        "",
        "# Gateway",
      ].join("\n"),
    );

    const result = spawnSync(
      cliBinaryPath,
      [
        "--lang",
        "zh-CN",
        "--src",
        "en",
        "--docs",
        docsRoot,
        "--mode",
        "segment",
        "--thinking",
        "low",
        "--overwrite",
        sourcePath,
      ],
      {
        cwd: "scripts/docs-i18n",
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCS_I18N_CODEX_EXECUTABLE: translatorStubPath,
          XDG_CACHE_HOME: path.join(tempDir, "cache", "cli"),
        },
      },
    );
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || result.stdout || "docs-i18n CLI failed");
    }

    const output = readFileSync(path.join(docsRoot, "zh-CN", "guide.md"), "utf8");
    if (
      !output.includes("description: |-") ||
      !output.includes("    ...\n    retained scalar content")
    ) {
      throw new Error(`generated localized file lost the YAML scalar:\n${output}`);
    }
    if (!output.endsWith("# Gateway") || output.includes("\n...\n# Gateway")) {
      throw new Error(`generated localized file has an incorrect body boundary:\n${output}`);
    }
    console.log(
      `docs-i18n CLI generated localized file: description="...\\nretained scalar content" body="# Gateway"`,
    );
  });
});
