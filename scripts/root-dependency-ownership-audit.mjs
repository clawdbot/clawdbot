#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectBundledPluginRuntimeDependencySpecs,
  collectRootDistBundledRuntimeMirrors,
  packageNameFromSpecifier,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";

const DEFAULT_SCAN_ROOTS = ["src", "extensions", "packages", "ui", "scripts", "test"];
const SCANNED_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\b(?:require|[_$A-Za-z][\w$]*require[\w$]*)\.resolve\s*\(\s*["']([^"']+)["']\s*\)/gi,
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isScannableSourceFile(fileName) {
  return SCANNED_EXTENSIONS.has(path.extname(fileName));
}

function shouldSkipDir(dirName) {
  return dirName === "dist" || dirName === "node_modules" || dirName === ".git";
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const files = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && isScannableSourceFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function sectionFor(relativePath) {
  const [section = "other"] = relativePath.split("/");
  return section;
}

export function collectModuleSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  return specifiers;
}

function collectExtensionDependencyDeclarations(repoRoot) {
  const declarations = new Map();
  const extensionsRoot = path.join(repoRoot, "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return declarations;
  }

  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageJsonPath = path.join(extensionsRoot, entry.name, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = readJson(packageJsonPath);
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      for (const depName of Object.keys(packageJson[section] ?? {})) {
        const existing = declarations.get(depName) ?? [];
        existing.push(`${entry.name}:${section}`);
        declarations.set(depName, existing);
      }
    }
  }

  for (const values of declarations.values()) {
    values.sort((left, right) => left.localeCompare(right));
  }

  return declarations;
}

function sectionSetContainsCore(sectionSet) {
  return sectionSet.has("src") || sectionSet.has("packages") || sectionSet.has("ui");
}

function sectionSetIsSubsetOf(sectionSet, allowed) {
  for (const value of sectionSet) {
    if (!allowed.has(value)) {
      return false;
    }
  }
  return sectionSet.size > 0;
}

export function classifyRootDependencyOwnership(record) {
  const sections = new Set(record.sections);

  if (record.rootMirrorImporters.length > 0) {
    if (!sectionSetContainsCore(sections)) {
      return {
        category: "extension_only_localizable",
        recommendation:
          "remove from root package.json and rely on owning extension manifests plus doctor --fix",
      };
    }
  }

  if (sections.size === 0) {
    return {
      category: "unreferenced",
      recommendation: "investigate removal; no direct source imports found in scanned files",
    };
  }

  if (sectionSetIsSubsetOf(sections, new Set(["scripts", "test"]))) {
    return {
      category: "script_or_test_only",
      recommendation: "consider moving from dependencies to devDependencies",
    };
  }

  if (sectionSetContainsCore(sections)) {
    if (sections.has("extensions")) {
      return {
        category: "shared_core_and_extension",
        recommendation:
          "keep at root until shared code is split or extension/core boundary changes",
      };
    }
    return {
      category: "core_runtime",
      recommendation: "keep at root",
    };
  }

  if (sectionSetIsSubsetOf(sections, new Set(["extensions", "test"]))) {
    return {
      category: "extension_only_localizable",
      recommendation:
        "remove from root package.json and rely on owning extension manifests plus doctor --fix",
    };
  }

  return {
    category: "mixed_noncore",
    recommendation: "inspect manually; usage spans non-core surfaces",
  };
}

export function collectRootDependencyOwnershipAudit(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const rootPackageJson = readJson(path.join(repoRoot, "package.json"));
  const rootDependencies = {
    ...rootPackageJson.dependencies,
    ...rootPackageJson.optionalDependencies,
  };
  const records = new Map(
    Object.keys(rootDependencies).map((depName) => [
      depName,
      {
        depName,
        sections: new Set(),
        files: new Set(),
        declaredInExtensions: [],
        rootMirrorImporters: [],
        spec: rootDependencies[depName],
      },
    ]),
  );

  const scanRoots = params.scanRoots ?? DEFAULT_SCAN_ROOTS;
  for (const scanRoot of scanRoots) {
    for (const filePath of walkFiles(path.join(repoRoot, scanRoot))) {
      const relativePath = normalizeRelativePath(filePath, repoRoot);
      const source = fs.readFileSync(filePath, "utf8");
      for (const specifier of collectModuleSpecifiers(source)) {
        const depName = packageNameFromSpecifier(specifier);
        if (!depName || !records.has(depName)) {
          continue;
        }
        const record = records.get(depName);
        record.sections.add(sectionFor(relativePath));
        record.files.add(relativePath);
      }
    }
  }

  const extensionDeclarations = collectExtensionDependencyDeclarations(repoRoot);
  for (const [depName, declarations] of extensionDeclarations) {
    const record = records.get(depName);
    if (record) {
      record.declaredInExtensions = declarations;
    }
  }

  const distDir = path.join(repoRoot, "dist");
  if (fs.existsSync(distDir)) {
    const bundledSpecs = collectBundledPluginRuntimeDependencySpecs(
      path.join(repoRoot, "extensions"),
    );
    const rootMirrors = collectRootDistBundledRuntimeMirrors({
      bundledRuntimeDependencySpecs: bundledSpecs,
      distDir,
    });
    for (const [depName, mirror] of rootMirrors) {
      const record = records.get(depName);
      if (!record) {
        continue;
      }
      record.rootMirrorImporters = [...mirror.importers].toSorted((left, right) =>
        left.localeCompare(right),
      );
    }
  }

  return [...records.values()]
    .map((record) => {
      const classification = classifyRootDependencyOwnership({
        ...record,
        sections: [...record.sections].toSorted((left, right) => left.localeCompare(right)),
      });
      return {
        depName: record.depName,
        spec: record.spec,
        sections: [...record.sections].toSorted((left, right) => left.localeCompare(right)),
        fileCount: record.files.size,
        sampleFiles: [...record.files].slice(0, 5),
        declaredInExtensions: record.declaredInExtensions,
        rootMirrorImporters: record.rootMirrorImporters,
        category: classification.category,
        recommendation: classification.recommendation,
      };
    })
    .toSorted((left, right) => left.depName.localeCompare(right.depName));
}

function printTextReport(records) {
  const grouped = new Map();
  for (const record of records) {
    const existing = grouped.get(record.category) ?? [];
    existing.push(record);
    grouped.set(record.category, existing);
  }

  for (const category of [...grouped.keys()].toSorted((left, right) => left.localeCompare(right))) {
    console.log(`\n## ${category}`);
    for (const record of grouped.get(category)) {
      const details = [`sections=${record.sections.join(",") || "-"}`, `files=${record.fileCount}`];
      if (record.declaredInExtensions.length > 0) {
        details.push(`extensions=${record.declaredInExtensions.join(",")}`);
      }
      if (record.rootMirrorImporters.length > 0) {
        details.push(`rootDist=${record.rootMirrorImporters.join(",")}`);
      }
      console.log(`- ${record.depName}@${record.spec} :: ${details.join(" | ")}`);
      console.log(`  ${record.recommendation}`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes("--json");
  const records = collectRootDependencyOwnershipAudit();
  if (asJson) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  printTextReport(records);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
