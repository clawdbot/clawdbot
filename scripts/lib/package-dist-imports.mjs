// Scans packaged dist JavaScript for relative imports and missing closure entries.
import { createRequire } from "node:module";
import path from "node:path";
import { visitModuleSpecifiers } from "./guard-inventory-utils.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const JS_DIST_FILE_RE = /^dist\/.*\.(?:cjs|js|mjs)$/u;

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function hasJavaScriptFileExtension(value) {
  return /\.(?:cjs|js|mjs)$/u.test(path.posix.basename(stripSpecifierSuffix(value)));
}

function resolveDistImportPath(importerPath, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const stripped = stripSpecifierSuffix(specifier);
  if (!stripped) {
    return null;
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), stripped));
}

function collectImportSpecifiers(source, importerPath) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    importerPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  visitModuleSpecifiers(
    ts,
    sourceFile,
    ({ kind, specifier }) => {
      if (
        specifier.startsWith(".") &&
        (kind !== "import-meta-url" ||
          (hasJavaScriptFileExtension(specifier) &&
            resolveDistImportPath(importerPath, specifier)?.startsWith("dist/")))
      ) {
        specifiers.push(specifier);
      }
    },
    { includeCommonJs: true, includeImportMetaUrl: true },
  );
  return specifiers;
}

/** Collect missing-file errors for relative imports inside package dist files. */
export function collectPackageDistImportErrors(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const errors = [];
  const imports = params.imports ?? collectPackageDistImports({ files, readText: params.readText });

  for (const { importerPath, importedPath } of imports) {
    if (!fileSet.has(importedPath)) {
      errors.push(`${importerPath} imports missing ${importedPath}`);
    }
  }

  return errors;
}

/** Collect relative dist import edges from package JavaScript files. */
export function collectPackageDistImports(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const imports = [];

  for (const importerPath of files.toSorted((left, right) => left.localeCompare(right))) {
    if (!JS_DIST_FILE_RE.test(importerPath) || importerPath.includes("/node_modules/")) {
      continue;
    }
    const source = params.readText(importerPath);
    for (const specifier of collectImportSpecifiers(source, importerPath)) {
      const importedPath = resolveDistImportPath(importerPath, specifier);
      if (!importedPath) {
        continue;
      }
      imports.push({ importerPath, importedPath });
    }
  }

  return imports;
}

/** Expand seed dist files to include all reachable relative dist imports. */
export function expandPackageDistImportClosure(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const expectedSet = new Set(params.seedFiles.map(normalizePackagePath));
  const imports = params.imports ?? collectPackageDistImports({ files, readText: params.readText });
  const importsByImporter = new Map();
  for (const { importerPath, importedPath } of imports) {
    const importerImports = importsByImporter.get(importerPath) ?? [];
    importerImports.push(importedPath);
    importsByImporter.set(importerPath, importerImports);
  }

  const queue = [...expectedSet].filter((file) => fileSet.has(file));
  for (const importerPath of queue) {
    for (const importedPath of importsByImporter.get(importerPath) ?? []) {
      if (fileSet.has(importedPath) && !expectedSet.has(importedPath)) {
        expectedSet.add(importedPath);
        queue.push(importedPath);
      }
    }
  }

  return [...expectedSet].toSorted((left, right) => left.localeCompare(right));
}
