// Shared ignore-rules tests cover workspace ignore-file scanning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIgnoreRules } from "./ignore-rules.js";

function oversizedIgnoreFileContent(): string {
  return `#${"x".repeat(4 * 1024 * 1024)}`;
}

describe("addIgnoreRules", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ignore-rules-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("loads patterns from a .gitignore file", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules/\ndist/\n", "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("node_modules/foo")).toBe(true);
    expect(ig.ignores("dist/bar.js")).toBe(true);
    expect(ig.ignores("src/main.ts")).toBe(false);
  });

  it("parses a large ignore file under the byte cap", () => {
    const huge = `#${"x".repeat(2 * 1024 * 1024)}\nignored-file\n`;
    fs.writeFileSync(path.join(tempDir, ".gitignore"), huge, "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("ignored-file")).toBe(true);
    expect(ig.ignores("unrelated-file")).toBe(false);
  });

  it("fails closed and excludes the subtree when an ignore file exceeds the byte cap", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversizedIgnoreFileContent(), "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("unrelated-file")).toBe(true);
  });

  it("fails closed before an under-cap file can amplify into too many rules", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "a\n".repeat(20_001), "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("unrelated-file")).toBe(true);
  });

  it("enforces the rule-count budget across ignore files", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "a\n".repeat(10_000), "utf-8");
    fs.writeFileSync(path.join(tempDir, ".ignore"), "b\n".repeat(10_001), "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("unrelated-file")).toBe(true);
  });

  it("fails closed before compiling an excessively long pattern", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "a".repeat(16 * 1024 + 1), "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("unrelated-file")).toBe(true);
  });

  it("counts directory prefixes toward the compiled-pattern budget", () => {
    const first = "a".repeat(150);
    const second = "b".repeat(150);
    const nestedDir = path.join(tempDir, first, second);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, ".gitignore"), "x\n".repeat(20_000), "utf-8");

    const ig = addIgnoreRules(nestedDir, tempDir);

    expect(ig.ignores(`${first}/${second}`)).toBe(true);
    expect(ig.ignores(`${first}/${second}/secret.txt`)).toBe(true);
  });

  it("keeps the subtree excluded when a later ignore file negates it", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversizedIgnoreFileContent(), "utf-8");
    // A later .ignore could reopen the subtree if the oversized-file exclusion
    // were not terminal for this directory.
    fs.writeFileSync(path.join(tempDir, ".ignore"), "!ignored-file\n!secret.txt\n", "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("ignored-file")).toBe(true);
    expect(ig.ignores("secret.txt")).toBe(true);
  });

  it("treats fail-closed subtree paths literally", () => {
    const oversized = oversizedIgnoreFileContent();
    const unusualNames = [
      "Private",
      "#private",
      "!private",
      "[private]",
      ...(process.platform === "win32" ? [] : ["private?docs", "private*docs"]),
    ];
    let ig: ReturnType<typeof addIgnoreRules> | undefined;

    for (const name of unusualNames) {
      const nestedDir = path.join(tempDir, name);
      fs.mkdirSync(nestedDir);
      fs.writeFileSync(path.join(nestedDir, ".gitignore"), oversized, "utf-8");
      ig = ig
        ? addIgnoreRules(nestedDir, tempDir, ig, { ignoreCase: true })
        : addIgnoreRules(nestedDir, tempDir);

      expect(ig.ignores(name)).toBe(true);
      expect(ig.ignores(`${name}/secret.txt`)).toBe(true);
      expect(ig.ignores([name, "nested", "secret.txt"].join(path.sep))).toBe(true);
    }

    if (!ig) {
      throw new Error("expected ignore matcher");
    }
    expect(ig.ignores("public/secret.txt")).toBe(false);
    expect(ig.ignores("private/secret.txt")).toBe(true);
    if (process.platform !== "win32") {
      expect(ig.ignores("#private\\secret.txt")).toBe(false);
    }
  });

  it("preserves case-sensitive semantics for a supplied matcher", () => {
    const nestedDir = path.join(tempDir, "Private");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, ".gitignore"), oversizedIgnoreFileContent(), "utf-8");

    const ig = addIgnoreRules(nestedDir, tempDir, ignore({ ignorecase: false }), {
      ignoreCase: false,
    });

    expect(ig.ignores("Private/secret.txt")).toBe(true);
    expect(ig.ignores("private/secret.txt")).toBe(false);

    const otherDir = path.join(tempDir, "Other");
    fs.mkdirSync(otherDir);
    fs.writeFileSync(path.join(otherDir, ".gitignore"), oversizedIgnoreFileContent(), "utf-8");
    addIgnoreRules(otherDir, tempDir, ig, { ignoreCase: false });
    expect(ig.ignores("Other/secret.txt")).toBe(true);
    expect(ig.ignores("other/secret.txt")).toBe(false);
  });

  it("preserves case-insensitive semantics for a supplied default matcher", () => {
    const nestedDir = path.join(tempDir, "Private");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, ".gitignore"), oversizedIgnoreFileContent(), "utf-8");

    const ig = addIgnoreRules(nestedDir, tempDir, ignore(), { ignoreCase: true });

    expect(ig.ignores("Private/secret.txt")).toBe(true);
    expect(ig.ignores("private/secret.txt")).toBe(true);
  });

  it("adopts the explicit case mode after matcher composition", () => {
    const source = addIgnoreRules(tempDir, tempDir);
    const inherited = ignore().add(source);
    const nestedDir = path.join(tempDir, "Private");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, ".gitignore"), oversizedIgnoreFileContent(), "utf-8");

    addIgnoreRules(nestedDir, tempDir, inherited, { ignoreCase: true });

    expect(inherited.ignores("Private/secret.txt")).toBe(true);
    expect(inherited.ignores("private/secret.txt")).toBe(true);
  });

  it("keeps fail-closed metadata when the matcher is extended", () => {
    const nestedDir = path.join(tempDir, "locked");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, ".gitignore"), oversizedIgnoreFileContent(), "utf-8");
    const ig = addIgnoreRules(nestedDir, tempDir);

    fs.writeFileSync(path.join(tempDir, ".gitignore"), "!locked/\n!locked/secret.txt\n", "utf-8");
    addIgnoreRules(tempDir, tempDir, ig, { ignoreCase: true });

    expect(ig.ignores("locked")).toBe(true);
    expect(ig.ignores("locked/secret.txt")).toBe(true);

    const inherited = ignore().add(ig);
    inherited.add("!locked/\n!locked/secret.txt");
    expect(inherited.ignores("locked")).toBe(true);
    expect(inherited.ignores("locked/secret.txt")).toBe(true);
  });

  it("preserves the configured ignore matcher surface", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "from-file\n", "utf-8");
    const configured = ignore().add("preconfigured");

    const ig = addIgnoreRules(tempDir, tempDir, configured, { ignoreCase: true });

    expect(ig).toBe(configured);
    expect(ig.ignores("preconfigured")).toBe(true);
    expect(ig.test("from-file").ignored).toBe(true);
    expect(ig.filter(["from-file", "visible"])).toEqual(["visible"]);
    expect(["from-file", "visible"].filter(ig.createFilter())).toEqual(["visible"]);
    ig.add("added-later");
    expect(ig.ignores("added-later")).toBe(true);
  });

  it("follows a symlinked .gitignore to a regular file", () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ignore-rules-real-"));
    try {
      fs.writeFileSync(path.join(realDir, "real.gitignore"), "node_modules/\n", "utf-8");
      fs.symlinkSync(path.join(realDir, "real.gitignore"), path.join(tempDir, ".gitignore"));

      const ig = addIgnoreRules(tempDir, tempDir);

      expect(ig.ignores("node_modules/foo")).toBe(true);
    } finally {
      fs.rmSync(realDir, { force: true, recursive: true });
    }
  });

  it("follows a chain of symlinks to the final regular .gitignore", () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ignore-rules-real-"));
    try {
      fs.writeFileSync(path.join(realDir, "real.gitignore"), "node_modules/\n", "utf-8");
      const linkA = path.join(realDir, "link-a");
      const linkB = path.join(realDir, "link-b");
      fs.symlinkSync(path.join(realDir, "real.gitignore"), linkA);
      fs.symlinkSync(linkA, linkB);
      fs.symlinkSync(linkB, path.join(tempDir, ".gitignore"));

      const ig = addIgnoreRules(tempDir, tempDir);

      expect(ig.ignores("node_modules/foo")).toBe(true);
    } finally {
      fs.rmSync(realDir, { force: true, recursive: true });
    }
  });
});
