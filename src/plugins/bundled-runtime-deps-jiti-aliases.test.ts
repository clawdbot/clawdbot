import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearBundledRuntimeDependencyJitiAliases,
  registerBundledRuntimeDependencyJitiAliases,
  resolveBundledRuntimeDependencyJitiAliasMap,
} from "./bundled-runtime-deps-jiti-aliases.js";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-aliases-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "export default null;\n", "utf8");
}

function packageRoot(rootDir: string, packageName: string): string {
  return path.join(rootDir, "node_modules", ...packageName.split("/"));
}

afterEach(() => {
  clearBundledRuntimeDependencyJitiAliases();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("bundled runtime dependency Jiti aliases", () => {
  it("registers root, subpath, wildcard, and scoped package aliases", () => {
    const rootDir = makeTempRoot();
    writeJson(path.join(rootDir, "package.json"), {
      dependencies: {
        plain: "1.0.0",
        wild: "1.0.0",
        "@scope/pkg": "1.0.0",
      },
    });

    const plainRoot = packageRoot(rootDir, "plain");
    writeJson(path.join(plainRoot, "package.json"), {
      exports: {
        ".": { import: "./esm/index.js", default: "./cjs/index.js" },
        "./feature": "./features/feature.js",
      },
    });
    writeFile(path.join(plainRoot, "cjs/index.js"));
    writeFile(path.join(plainRoot, "features/feature.js"));

    const wildRoot = packageRoot(rootDir, "wild");
    writeJson(path.join(wildRoot, "package.json"), {
      exports: {
        "./sub/*": "./dist/*.js",
      },
    });
    writeFile(path.join(wildRoot, "dist/a.js"));
    writeFile(path.join(wildRoot, "dist/nested/b.js"));

    const scopedRoot = packageRoot(rootDir, "@scope/pkg");
    writeJson(path.join(scopedRoot, "package.json"), {
      module: "./index.mjs",
    });
    writeFile(path.join(scopedRoot, "index.mjs"));

    registerBundledRuntimeDependencyJitiAliases(rootDir);

    expect(resolveBundledRuntimeDependencyJitiAliasMap()).toEqual({
      "wild/sub/nested/b": path.join(wildRoot, "dist/nested/b.js"),
      "plain/feature": path.join(plainRoot, "features/feature.js"),
      "@scope/pkg": path.join(scopedRoot, "index.mjs"),
      "wild/sub/a": path.join(wildRoot, "dist/a.js"),
      plain: path.join(plainRoot, "cjs/index.js"),
    });
  });

  it("prefers require-compatible conditional exports for CommonJS-only runtime deps", () => {
    const rootDir = makeTempRoot();
    writeJson(path.join(rootDir, "package.json"), {
      dependencies: {
        ws: "8.20.0",
      },
    });
    const wsRoot = packageRoot(rootDir, "ws");
    writeJson(path.join(wsRoot, "package.json"), {
      exports: {
        ".": {
          browser: "./browser.js",
          import: "./wrapper.mjs",
          require: "./index.js",
        },
      },
    });
    writeFile(path.join(wsRoot, "wrapper.mjs"));
    writeFile(path.join(wsRoot, "index.js"));

    registerBundledRuntimeDependencyJitiAliases(rootDir);

    expect(resolveBundledRuntimeDependencyJitiAliasMap()).toEqual({
      ws: path.join(wsRoot, "index.js"),
    });
  });

  it("honors package condition order before top-level require fallbacks", () => {
    const rootDir = makeTempRoot();
    writeJson(path.join(rootDir, "package.json"), {
      dependencies: {
        conditional: "1.0.0",
      },
    });
    const conditionalRoot = packageRoot(rootDir, "conditional");
    writeJson(path.join(conditionalRoot, "package.json"), {
      exports: {
        ".": {
          browser: {
            default: "./dist/web/index.js",
          },
          node: {
            import: "./dist/node/index.mjs",
            require: "./dist/node/index.cjs",
            default: "./dist/node/index.mjs",
          },
          import: "./dist/index.mjs",
          require: "./dist/index.cjs",
          default: "./dist/index.mjs",
        },
      },
    });
    writeFile(path.join(conditionalRoot, "dist/index.cjs"));
    writeFile(path.join(conditionalRoot, "dist/node/index.cjs"));

    registerBundledRuntimeDependencyJitiAliases(rootDir);

    expect(resolveBundledRuntimeDependencyJitiAliasMap()).toEqual({
      conditional: path.join(conditionalRoot, "dist/node/index.cjs"),
    });
  });

  it("falls back to import-only conditional exports for staged runtime deps", () => {
    const rootDir = makeTempRoot();
    writeJson(path.join(rootDir, "package.json"), {
      dependencies: {
        "import-only": "1.0.0",
      },
    });
    const importOnlyRoot = packageRoot(rootDir, "import-only");
    writeJson(path.join(importOnlyRoot, "package.json"), {
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
        "./provider": {
          types: "./dist/provider.d.ts",
          import: "./dist/provider.js",
        },
      },
    });
    writeFile(path.join(importOnlyRoot, "dist/index.js"));
    writeFile(path.join(importOnlyRoot, "dist/provider.js"));

    registerBundledRuntimeDependencyJitiAliases(rootDir);

    expect(resolveBundledRuntimeDependencyJitiAliasMap()).toEqual({
      "import-only/provider": path.join(importOnlyRoot, "dist/provider.js"),
      "import-only": path.join(importOnlyRoot, "dist/index.js"),
    });
  });

  it("ignores missing, private, and escaping export targets", () => {
    const rootDir = makeTempRoot();
    writeJson(path.join(rootDir, "package.json"), {
      dependencies: {
        unsafe: "1.0.0",
      },
    });
    const unsafeRoot = packageRoot(rootDir, "unsafe");
    writeJson(path.join(unsafeRoot, "package.json"), {
      exports: {
        ".": "../outside.js",
        "./private": "#internal",
        "./missing": "./missing.js",
      },
    });

    registerBundledRuntimeDependencyJitiAliases(rootDir);

    expect(resolveBundledRuntimeDependencyJitiAliasMap()).toBeUndefined();
  });
});
