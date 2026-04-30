import path from "node:path";

const JS_DIST_FILE_RE = /^dist\/.*\.(?:cjs|js|mjs)$/u;

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
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

function findStatementStart(source, index) {
  return (
    Math.max(
      source.lastIndexOf(";", index),
      source.lastIndexOf("{", index),
      source.lastIndexOf("}", index),
      source.lastIndexOf("\n", index),
      source.lastIndexOf("\r", index),
    ) + 1
  );
}

function isImportSpecifierContext(source, index) {
  const dynamicPrefix = source.slice(Math.max(0, index - 32), index);
  if (/\bimport\s*\(\s*$/u.test(dynamicPrefix)) {
    return true;
  }
  const statementPrefix = source.slice(findStatementStart(source, index), index).trimStart();
  return (
    /^(?:import|export)\b[\s\S]*\bfrom\s*$/u.test(statementPrefix) ||
    /^import\s*$/u.test(statementPrefix)
  );
}

function collectImportSpecifiers(source) {
  const specifiers = [];
  let inBlockComment = false;
  let inLineComment = false;
  for (let index = 0; index < source.length; index += 1) {
    if (inBlockComment) {
      if (source[index] === "*" && source[index + 1] === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inLineComment) {
      if (source[index] === "\n" || source[index] === "\r") {
        inLineComment = false;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      continue;
    }

    let cursor = index + 1;
    let value = "";
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        value += source.slice(cursor, cursor + 2);
        cursor += 2;
        continue;
      }
      if (char === quote) {
        break;
      }
      value += char;
      cursor += 1;
    }
    if (cursor >= source.length) {
      break;
    }

    if (value.startsWith(".")) {
      if (isImportSpecifierContext(source, index)) {
        specifiers.push(value);
      }
    }
    index = cursor;
  }
  return specifiers;
}

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

export function collectPackageDistImports(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const imports = [];

  for (const importerPath of files.toSorted((left, right) => left.localeCompare(right))) {
    if (!JS_DIST_FILE_RE.test(importerPath) || importerPath.includes("/node_modules/")) {
      continue;
    }
    const source = params.readText(importerPath);
    for (const specifier of collectImportSpecifiers(source)) {
      const importedPath = resolveDistImportPath(importerPath, specifier);
      if (!importedPath) {
        continue;
      }
      imports.push({ importerPath, importedPath });
    }
  }

  return imports;
}

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
  for (let index = 0; index < queue.length; index += 1) {
    const importerPath = queue[index];
    for (const importedPath of importsByImporter.get(importerPath) ?? []) {
      if (fileSet.has(importedPath) && !expectedSet.has(importedPath)) {
        expectedSet.add(importedPath);
        queue.push(importedPath);
      }
    }
  }

  return [...expectedSet].toSorted((left, right) => left.localeCompare(right));
}
