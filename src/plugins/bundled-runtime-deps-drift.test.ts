import fs from "node:fs";
import { Module } from "node:module";
import path from "node:path";
import { describe, it } from "vitest";

describe("mirrored root runtime dependency drift guard", () => {
  // Intentionally not mirrored at runtime: build-only / type-only / TUI-only
  // tooling and packages that resolve transitively through other mirrored deps.
  // If you change this set, document why in the comment beside the entry.
  const KNOWN_UNMIRRORED_BARE_IMPORTS = new Set<string>([
    "@mariozechner/pi-tui", // TUI mode runs from npm-global, not the gateway runtime mirror
    "chalk", // available transitively via mirrored deps
    "file-type", // available transitively via mirrored deps
    "ipaddr.js", // available transitively via mirrored deps
    "proxy-agent", // available transitively via mirrored deps
    "qrcode", // type-only import in src/media/qr-runtime.ts
    "typescript", // CLI/dev only (api-baseline, jiti-runtime-api)
  ]);

  function locateRepoRoot(): string {
    let dir = path.resolve(import.meta.dirname);
    for (let depth = 0; depth < 10; depth += 1) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        try {
          const data = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
          if (data.name === "openclaw") {
            return dir;
          }
        } catch {
          // fall through
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error("could not locate openclaw repo root from test file");
  }

  function readPackageJsonDeps(packageJsonPath: string): Set<string> {
    const out = new Set<string>();
    if (!fs.existsSync(packageJsonPath)) {
      return out;
    }
    let parsed: {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    try {
      parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    } catch {
      return out;
    }
    for (const name of Object.keys(parsed.dependencies ?? {})) {
      out.add(name);
    }
    for (const name of Object.keys(parsed.optionalDependencies ?? {})) {
      out.add(name);
    }
    return out;
  }

  function readMirroredRootRuntimeDeps(repoRoot: string): Set<string> {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      openclaw?: {
        bundle?: {
          mirroredRootRuntimeDependencies?: unknown;
        };
      };
    };
    const deps = parsed.openclaw?.bundle?.mirroredRootRuntimeDependencies;
    return new Set(Array.isArray(deps) ? deps.filter((dep) => typeof dep === "string") : []);
  }

  function collectExtensionOwnedDeps(repoRoot: string): Set<string> {
    const out = new Set<string>();
    const extensionsDir = path.join(repoRoot, "extensions");
    if (!fs.existsSync(extensionsDir)) {
      return out;
    }
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      for (const name of readPackageJsonDeps(
        path.join(extensionsDir, entry.name, "package.json"),
      )) {
        out.add(name);
      }
    }
    return out;
  }

  function walkCoreSourceFiles(repoRoot: string): string[] {
    const srcDir = path.join(repoRoot, "src");
    const files: string[] = [];
    const queue: string[] = [srcDir];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) {
            continue;
          }
          queue.push(full);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (
          /\.test\.tsx?$/u.test(entry.name) ||
          /\.e2e\.test\.tsx?$/u.test(entry.name) ||
          /\.test-helpers?\.tsx?$/u.test(entry.name) ||
          /\.test-fixture\.tsx?$/u.test(entry.name) ||
          entry.name.endsWith(".d.ts") ||
          !/\.(?:ts|tsx|cjs|mjs|js)$/u.test(entry.name)
        ) {
          continue;
        }
        files.push(full);
      }
    }
    return files;
  }

  function packageNameFromBareSpecifier(specifier: string): string | null {
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("node:") ||
      specifier.startsWith("#")
    ) {
      return null;
    }
    const [first, second] = specifier.split("/");
    if (!first) {
      return null;
    }
    return first.startsWith("@") && second ? `${first}/${second}` : first;
  }

  // Match value imports (`import x from 'y'`, `import 'y'`, `require('y')`,
  // `import('y')`) but skip `import type` to avoid noise from type-only imports.
  const VALUE_IMPORT_PATTERNS = [
    /(?:^|[;\n])\s*import\s+(?!type\b)(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ] as const;

  it("every value-imported root-package dep in src/ is mirrored or owned by an extension", () => {
    const repoRoot = locateRepoRoot();
    const rootDeps = readPackageJsonDeps(path.join(repoRoot, "package.json"));
    const extensionDeps = collectExtensionOwnedDeps(repoRoot);
    const mirroredCore = readMirroredRootRuntimeDeps(repoRoot);
    const nodeBuiltins = new Set<string>(Module.builtinModules);

    const violations = new Map<string, string>();
    for (const file of walkCoreSourceFiles(repoRoot)) {
      const source = fs.readFileSync(file, "utf8");
      const specifiers = new Set<string>();
      for (const pattern of VALUE_IMPORT_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          if (match[1]) {
            specifiers.add(match[1]);
          }
        }
      }
      for (const specifier of specifiers) {
        const packageName = packageNameFromBareSpecifier(specifier);
        if (!packageName) {
          continue;
        }
        if (nodeBuiltins.has(packageName)) {
          continue;
        }
        if (packageName === "openclaw" || packageName.startsWith("@openclaw/")) {
          continue;
        }
        if (mirroredCore.has(packageName) || extensionDeps.has(packageName)) {
          continue;
        }
        if (KNOWN_UNMIRRORED_BARE_IMPORTS.has(packageName)) {
          continue;
        }
        if (!rootDeps.has(packageName)) {
          // Not a root runtime dep; not our concern (could be a peer/dev import
          // that resolves through some other path; the mirror does not own it).
          continue;
        }
        if (!violations.has(packageName)) {
          violations.set(packageName, path.relative(repoRoot, file).replaceAll(path.sep, "/"));
        }
      }
    }

    if (violations.size > 0) {
      const summary = [...violations.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([packageName, filePath]) => `  - ${packageName} (e.g. ${filePath})`)
        .join("\n");
      throw new Error(
        [
          "Bare imports found in src/ that are root-package runtime deps but are neither",
          "in package.json openclaw.bundle.mirroredRootRuntimeDependencies nor declared by any extension's package.json.",
          "These will be missing from the runtime-deps mirror at gateway start and Node",
          "will fail to resolve them. Either add the package to openclaw.bundle.mirroredRootRuntimeDependencies,",
          "declare it under an owning extension's dependencies, or add it to",
          "KNOWN_UNMIRRORED_BARE_IMPORTS in this test with a comment explaining why.",
          "",
          summary,
        ].join("\n"),
      );
    }
  });
});
