import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const CHECK_SCRIPT = "scripts/check-package-dist-imports.mjs";
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-package-dist-imports", () => {
  it("prints help before reading package state", () => {
    const result = spawnSync("node", [CHECK_SCRIPT, "--help"], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node scripts/check-package-dist-imports.mjs [package-root]",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects option-like and extra arguments before dist scanning", () => {
    const unknown = spawnSync("node", [CHECK_SCRIPT, "--tag"], { encoding: "utf8" });

    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown package dist import check option: --tag");
    expect(unknown.stderr).not.toContain("missing dist directory");

    const extra = spawnSync("node", [CHECK_SCRIPT, ".", "extra"], { encoding: "utf8" });

    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toContain("Unexpected package dist import check argument: extra");
    expect(extra.stderr).not.toContain("missing dist directory");
  });

  it("accepts a minimal package dist root", () => {
    const root = makeTempDir(tempDirs, "openclaw-package-dist-imports-");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "export {};\n", "utf8");

    const result = spawnSync("node", [CHECK_SCRIPT, root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OpenClaw package dist import closure passed.");
  });

  it.each([
    {
      name: "named imports",
      source: 'import { value } from "./missing.js";\n',
    },
    {
      name: "multiline named imports",
      source: 'import {\n  value,\n} from "./missing.js";\n',
    },
    {
      name: "named re-exports",
      source: 'export { value } from "./missing.js";\n',
    },
    {
      name: "multiline named re-exports",
      source: 'export {\n  value,\n} from "./missing.js";\n',
    },
  ])("rejects missing chunks in $name", ({ source }) => {
    const root = makeTempDir(tempDirs, "openclaw-package-dist-imports-");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), source, "utf8");

    const result = spawnSync("node", [CHECK_SCRIPT, root], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dist/index.js imports missing dist/missing.js");
  });

  it("ignores import-like text inside multiline template literals", () => {
    const root = makeTempDir(tempDirs, "openclaw-package-dist-imports-");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "index.js"),
      'const example = `\nimport "./phantom.js"\n`;\n',
      "utf8",
    );

    const result = spawnSync("node", [CHECK_SCRIPT, root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OpenClaw package dist import closure passed.");
  });

  it.each([
    "../../openclaw.mjs",
    "../../scripts/run-node.mjs",
    "../../dist/entry.js",
    "../../dist/entry.mjs",
  ])("ignores import.meta.url probes outside packaged dist (%s)", (specifier) => {
    const root = makeTempDir(tempDirs, "openclaw-package-dist-imports-");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "index.js"),
      `const candidate = new URL(${JSON.stringify(specifier)}, import.meta.url);\n`,
      "utf8",
    );

    const result = spawnSync("node", [CHECK_SCRIPT, root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OpenClaw package dist import closure passed.");
  });

  it("rejects missing CommonJS require chunks", () => {
    const root = makeTempDir(tempDirs, "openclaw-package-dist-imports-");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "index.cjs"),
      'module.exports = require("./chunk.cjs");\n',
      "utf8",
    );

    const result = spawnSync("node", [CHECK_SCRIPT, root], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dist/index.cjs imports missing dist/chunk.cjs");
  });
});
