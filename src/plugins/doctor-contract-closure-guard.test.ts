// Doctor contract closure guard tests keep enumeration paths dependency-light.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { collectModuleReferencesFromSource } from "../../scripts/lib/guard-inventory-utils.mjs";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const FORBIDDEN_SPECIFIER = "openclaw/plugin-sdk/agent-runtime";
// Static value imports only; type-only and lazy dynamic imports of these stay allowed.
const FORBIDDEN_SPECIFIER_REASONS = new Map([
  [
    FORBIDDEN_SPECIFIER,
    "the deprecated broad barrel makes doctor enumeration cold-load the core agents graph; " +
      "use openclaw/plugin-sdk/agent-scope-runtime or another focused subpath",
  ],
  [
    "openclaw/plugin-sdk/runtime-doctor",
    "the heavy doctor barrel makes doctor enumeration cold-load the state-db/kysely graph; " +
      "use openclaw/plugin-sdk/runtime-doctor-migrations, or defer heavy helpers behind a dynamic import",
  ],
]);
const LEGACY_SETUP_PROPERTIES = new Set([
  "legacyStateMigrations",
  "legacySessionSurface",
  "legacySessionSurfaces",
]);

type ClosureEntry = {
  pluginId: string;
  pluginRoot: string;
  entryPath: string;
};

type ModuleReference = ReturnType<typeof collectModuleReferencesFromSource>[number];

function formatRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function isInsideRoot(rootPath: string, filePath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  return !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function resolveRelativeSourceModule(importerPath: string, specifier: string): string | null {
  const targetPath = path.resolve(path.dirname(importerPath), specifier);
  const targetExtension = path.extname(targetPath);
  const candidates: string[] = [];
  if (
    SOURCE_MODULE_EXTENSIONS.includes(targetExtension as (typeof SOURCE_MODULE_EXTENSIONS)[number])
  ) {
    const stem = targetPath.slice(0, -targetExtension.length);
    candidates.push(...SOURCE_MODULE_EXTENSIONS.map((extension) => `${stem}${extension}`));
  } else if (!targetExtension) {
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.push(`${targetPath}${extension}`, path.join(targetPath, `index${extension}`));
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

function collectLegacySetupSpecifiers(setupEntryPath: string): string[] {
  const source = fs.readFileSync(setupEntryPath, "utf8");
  const sourceFile = ts.createSourceFile(setupEntryPath, source, ts.ScriptTarget.Latest, true);
  const specifiers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      LEGACY_SETUP_PROPERTIES.has(propertyNameText(node.name) ?? "") &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyNameText(property.name) === "specifier" &&
          ts.isStringLiteralLike(property.initializer)
        ) {
          specifiers.add(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers].toSorted();
}

function collectStaticValueReferenceKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  const add = (kind: "commonjs-require" | "import" | "export", specifier: ts.StringLiteralLike) => {
    const line = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile)).line + 1;
    keys.add(`${kind}\0${line}\0${specifier.text}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const hasValueBinding =
        !clause ||
        (!clause.isTypeOnly &&
          (Boolean(clause.name) ||
            (clause.namedBindings !== undefined &&
              (ts.isNamespaceImport(clause.namedBindings) ||
                clause.namedBindings.elements.some((element) => !element.isTypeOnly)))));
      if (hasValueBinding) {
        add("import", node.moduleSpecifier);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      if (
        !clause ||
        ts.isNamespaceExport(clause) ||
        clause.elements.some((element) => !element.isTypeOnly)
      ) {
        add("export", node.moduleSpecifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add("commonjs-require", node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

function collectStaticValueReferences(filePath: string, source: string): ModuleReference[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const staticValueReferenceKeys = collectStaticValueReferenceKeys(sourceFile);
  return collectModuleReferencesFromSource(source, {
    fileName: filePath,
    acceptSpecifier: (specifier) =>
      FORBIDDEN_SPECIFIER_REASONS.has(specifier) || specifier.startsWith("."),
  }).filter((reference) =>
    staticValueReferenceKeys.has(`${reference.kind}\0${reference.line}\0${reference.specifier}`),
  );
}

function collectClosureEntries(): ClosureEntry[] {
  const entries: ClosureEntry[] = [];
  const env = {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(REPO_ROOT, "extensions"),
  };
  for (const record of loadBundledPluginManifestRegistry({ env }).plugins) {
    const pluginRoot = path.resolve(record.rootDir);
    const doctorContractPath = resolvePluginDoctorContractArtifactPath(pluginRoot);
    if (doctorContractPath) {
      entries.push({ pluginId: record.id, pluginRoot, entryPath: doctorContractPath });
    }

    if (record.channels.length === 0) {
      continue;
    }
    const packageJsonPath = path.join(pluginRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      openclaw?: { setupEntry?: unknown };
    };
    const setupEntry = packageJson.openclaw?.setupEntry;
    if (typeof setupEntry !== "string") {
      continue;
    }
    const setupEntryPath = path.resolve(pluginRoot, setupEntry);
    for (const specifier of collectLegacySetupSpecifiers(setupEntryPath)) {
      const entryPath = resolveRelativeSourceModule(setupEntryPath, specifier);
      if (entryPath && isInsideRoot(pluginRoot, entryPath)) {
        entries.push({ pluginId: record.id, pluginRoot, entryPath });
      }
    }
  }
  return entries;
}

function collectForbiddenClosureImports(entry: ClosureEntry): string[] {
  const violations: string[] = [];
  const visited = new Set<string>();
  const pending = [entry.entryPath];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const reference of collectStaticValueReferences(filePath, source)) {
      const reason = FORBIDDEN_SPECIFIER_REASONS.get(reference.specifier);
      if (reason) {
        violations.push(
          `${entry.pluginId}: ${formatRepoPath(filePath)}:${reference.line} imports ${reference.specifier}; ${reason}`,
        );
        continue;
      }
      const resolvedPath = resolveRelativeSourceModule(filePath, reference.specifier);
      if (resolvedPath && isInsideRoot(entry.pluginRoot, resolvedPath)) {
        pending.push(resolvedPath);
      }
    }
  }

  return violations;
}

describe("doctor contract import closures", () => {
  it("classifies only static value module edges", () => {
    const source = [
      `import type { A } from "${FORBIDDEN_SPECIFIER}";`,
      `import { type B } from "${FORBIDDEN_SPECIFIER}";`,
      `export type { C } from "${FORBIDDEN_SPECIFIER}";`,
      `export { type D } from "${FORBIDDEN_SPECIFIER}";`,
      `type E = import("${FORBIDDEN_SPECIFIER}").E;`,
      `const lazy = () => import("${FORBIDDEN_SPECIFIER}");`,
      `import { type F, value } from "${FORBIDDEN_SPECIFIER}";`,
      `export { type G, otherValue } from "${FORBIDDEN_SPECIFIER}";`,
    ].join("\n");

    expect(collectStaticValueReferences("fixture.ts", source)).toEqual([
      { kind: "import", line: 7, specifier: FORBIDDEN_SPECIFIER },
      { kind: "export", line: 8, specifier: FORBIDDEN_SPECIFIER },
    ]);
  });

  it("keeps broad agent runtime and heavy doctor barrels off doctor enumeration paths", () => {
    const violations = collectClosureEntries().flatMap(collectForbiddenClosureImports).toSorted();
    expect(violations).toStrictEqual([]);
  });
});
