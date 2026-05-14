import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_ROOT = "extensions";
const EXTENSION_RUNTIME_FILE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const BUILTIN_MODULES = new Set(builtinModules.map((moduleId) => moduleId.replace(/^node:/, "")));
const OPTIONAL_UNDECLARED_RUNTIME_IMPORTS = new Map<string, Set<string>>([
  [
    "extensions/canvas",
    // The A2UI bundle probes this optional markdown renderer and falls back when absent.
    new Set(["@a2ui/markdown-it"]),
  ],
  [
    "extensions/discord",
    // Prefer the pure-JS opusscript decoder, but keep the optional native decoder
    // fallback for users who install it themselves.
    new Set(["@discordjs/opus"]),
  ],
]);
const INDIRECT_RUNTIME_DEPENDENCIES = new Map<string, Set<string>>([
  [
    "extensions/browser",
    // The MCP SDK loads zod through its server/zod-compat runtime path.
    new Set(["zod"]),
  ],
  [
    "extensions/whatsapp",
    // Baileys loads these optional peers for media decoding and thumbnails.
    new Set(["audio-decode", "jimp"]),
  ],
  [
    "extensions/memory-lancedb",
    // LanceDB imports apache-arrow at runtime through its peer dependency.
    new Set(["apache-arrow"]),
  ],
  [
    "extensions/memory-core",
    // Packaged memory tools run through generated OpenClaw runtime chunks that parse JSON5 config.
    new Set(["json5"]),
  ],
  [
    "extensions/tlon",
    // The Tlon plugin manifest exposes the bundled skill from this package path.
    new Set(["@tloncorp/tlon-skill"]),
  ],
]);

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function readPackageManifest(filePath: string): PackageManifest {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageManifest;
}

function listPackageManifests(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const manifests: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(root, entry.name, "package.json");
    if (fs.existsSync(manifestPath)) {
      manifests.push(manifestPath);
    }
  }
  return manifests.toSorted();
}

function shouldSkipRuntimeFile(filePath: string): boolean {
  const normalized = toPosixPath(filePath);
  if (
    normalized.includes("/node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/coverage/") ||
    normalized.includes("/assets/") ||
    normalized.endsWith("/web/vite.config.ts")
  ) {
    return true;
  }
  return /(\.(test|spec|d)\.(ts|tsx|js|jsx|mjs|cjs)$|\/(test|tests|__tests__|test-support)\/|test-(helpers|support|harness|mocks|fixtures|runtime|shared|utils)|\.test-(helpers|support|harness|mocks|fixtures|runtime|shared|utils)|fixture-test-support|mock-setup|test-fixtures|test-runtime-mocks|\.harness\.|e2e-harness|\.mock\.|-mock\.|-mocks\.|mocks-test-support|\.fixture|\.fixtures)/.test(
    normalized,
  );
}

function listRuntimeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipRuntimeFile(filePath)) {
          visit(filePath);
        }
        continue;
      }
      if (
        EXTENSION_RUNTIME_FILE_EXTENSIONS.has(path.extname(entry.name)) &&
        !shouldSkipRuntimeFile(filePath)
      ) {
        files.push(filePath);
      }
    }
  };
  visit(root);
  return files.toSorted();
}

function readManifestText(root: string): string {
  const manifestPath = path.join(root, "openclaw.plugin.json");
  return fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
}

function packageNameForSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith("$") ||
    specifier.includes("${") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:")
  ) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? null;
}

function isTypeOnlyClause(clause: string | undefined): boolean {
  const trimmed = clause?.trim() ?? "";
  if (trimmed.startsWith("type ")) {
    return true;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  for (const part of trimmed.slice(1, -1).split(",")) {
    const importName = part.trim();
    if (importName.length > 0 && !importName.startsWith("type ")) {
      return false;
    }
  }
  return true;
}

function collectRuntimeImports(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const imports = new Set<string>();
  const importRegex =
    /(import|export)\s+([^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source))) {
    const clause = match[2];
    const specifier = match[3] ?? match[4] ?? match[5];
    if (!specifier || (match[1] && isTypeOnlyClause(clause))) {
      continue;
    }
    const packageName = packageNameForSpecifier(specifier);
    if (packageName) {
      imports.add(packageName);
    }
  }
  return [...imports].toSorted();
}

function runtimeDependencyNames(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

function allDependencyNames(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].toSorted();
}

function isDiscordPackageDependency(dependencyName: string): boolean {
  return (
    dependencyName === "discord-api-types" ||
    dependencyName === "opusscript" ||
    dependencyName.startsWith("@discordjs/") ||
    dependencyName.startsWith("@snazzah/")
  );
}

describe("Discord dependency ownership", () => {
  it("keeps Discord packages out of the root manifest", () => {
    const manifest = readPackageManifest("package.json");
    const discordDependencies = allDependencyNames(manifest).filter(isDiscordPackageDependency);

    expect(discordDependencies).toStrictEqual([]);
  });

  for (const manifestPath of listPackageManifests(EXTENSION_ROOT)) {
    const extensionDir = toPosixPath(path.dirname(manifestPath));

    if (extensionDir === "extensions/discord") {
      continue;
    }

    it(`${extensionDir} does not own Discord package dependencies`, () => {
      const manifest = readPackageManifest(manifestPath);
      const discordDependencies = allDependencyNames(manifest).filter(isDiscordPackageDependency);

      expect(discordDependencies).toStrictEqual([]);
    });
  }
});

describe("extension runtime dependency manifests", () => {
  it("keeps json5 in memory-core for packaged runtime config parsing", () => {
    const manifest = readPackageManifest("extensions/memory-core/package.json");

    expect(manifest.dependencies?.json5).toBeTypeOf("string");
    expect(manifest.dependencies?.json5).not.toBe("");
  });

  for (const manifestPath of listPackageManifests(EXTENSION_ROOT)) {
    const extensionDir = toPosixPath(path.dirname(manifestPath));

    it(`${extensionDir} declares every runtime package import`, () => {
      const manifest = readPackageManifest(manifestPath);
      const declared = runtimeDependencyNames(manifest);
      const allowedOptional =
        OPTIONAL_UNDECLARED_RUNTIME_IMPORTS.get(extensionDir) ?? new Set<string>();
      const missing = new Map<string, string[]>();

      for (const filePath of listRuntimeFiles(extensionDir)) {
        for (const packageName of collectRuntimeImports(filePath)) {
          if (
            packageName === "openclaw" ||
            packageName.startsWith("@openclaw/") ||
            BUILTIN_MODULES.has(packageName) ||
            declared.has(packageName) ||
            allowedOptional.has(packageName)
          ) {
            continue;
          }
          const files = missing.get(packageName) ?? [];
          files.push(toPosixPath(filePath));
          missing.set(packageName, files);
        }
      }

      expect(Object.fromEntries(missing)).toStrictEqual({});
    });

    it(`${extensionDir} does not keep unused direct runtime dependencies`, () => {
      const manifest = readPackageManifest(manifestPath);
      const declared = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ].toSorted();
      const allowedIndirect = INDIRECT_RUNTIME_DEPENDENCIES.get(extensionDir) ?? new Set<string>();
      const runtimeText = listRuntimeFiles(extensionDir)
        .map((filePath) => fs.readFileSync(filePath, "utf8"))
        .concat(readManifestText(extensionDir))
        .join("\n");

      const unused = declared.filter(
        (dependencyName) =>
          !allowedIndirect.has(dependencyName) && !runtimeText.includes(dependencyName),
      );

      expect(unused).toStrictEqual([]);
    });
  }
});
