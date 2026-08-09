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
type ClosureKind = "doctor-contract" | "legacy-setup";
// Static value imports only; type-only and lazy dynamic imports of these stay allowed.
// Rules scoped to "doctor-contract" protect doctor enumeration cold-load cost;
// legacy-setup closures (telegram sent-message-cache, discord thread-bindings.state)
// still share sync runtime modules with these barrels and are a named follow-up.
const FORBIDDEN_SPECIFIER_RULES = new Map<string, { reason: string; kinds: Set<ClosureKind> }>([
  [
    FORBIDDEN_SPECIFIER,
    {
      reason:
        "the deprecated broad barrel makes doctor enumeration cold-load the core agents graph; " +
        "use openclaw/plugin-sdk/agent-scope-runtime or another focused subpath",
      kinds: new Set(["doctor-contract", "legacy-setup"]),
    },
  ],
  [
    "openclaw/plugin-sdk/doctor-repair-runtime",
    {
      reason:
        "install-path, uninstall, and state-db schema repair cold-load the state-db/kysely graph; " +
        "use openclaw/plugin-sdk/runtime-doctor-migrations, or defer the repair behind a dynamic import",
      kinds: new Set(["doctor-contract", "legacy-setup"]),
    },
  ],
  [
    "openclaw/plugin-sdk/ssrf-runtime",
    {
      reason:
        "the SSRF runtime barrel cold-loads DNS, proxy state, and logging; " +
        "legacy private-network config migration lives in openclaw/plugin-sdk/runtime-doctor-migrations",
      kinds: new Set(["doctor-contract", "legacy-setup"]),
    },
  ],
  [
    "openclaw/plugin-sdk/provider-model-shared",
    {
      reason:
        "the provider-model barrel cold-loads replay/endpoint/catalog helpers; " +
        "use openclaw/plugin-sdk/model-ref-parse for provider/model reference parsing",
      kinds: new Set(["doctor-contract"]),
    },
  ],
  [
    "openclaw/plugin-sdk/channel-secret-basic-runtime",
    {
      reason:
        "the channel-secret barrel cold-loads secret-ref/account-routing modules; " +
        "the canonical record guard is openclaw/plugin-sdk/string-coerce-runtime",
      kinds: new Set(["doctor-contract"]),
    },
  ],
  [
    "openclaw/plugin-sdk/plugin-state-store-runtime",
    {
      reason:
        "opening a keyed plugin-state store cold-loads the state-db/kysely graph; " +
        "keep the store behind the migration context or a dynamic import inside async bodies",
      kinds: new Set(["doctor-contract"]),
    },
  ],
  [
    "openclaw/plugin-sdk/session-store-runtime",
    {
      reason:
        "the session-store barrel makes doctor enumeration cold-load the session-accessor/kysely graph; " +
        "defer it behind a dynamic import inside async migration bodies",
      kinds: new Set(["doctor-contract"]),
    },
  ],
  [
    "openclaw/plugin-sdk/logging-core",
    {
      reason:
        "the logging barrel makes doctor enumeration cold-load the diagnostic/config graph; " +
        "use openclaw/plugin-sdk/security-runtime for redaction helpers",
      kinds: new Set(["doctor-contract", "legacy-setup"]),
    },
  ],
  [
    "openclaw/plugin-sdk/realtime-voice",
    {
      reason:
        "the realtime-voice barrel makes doctor enumeration cold-load the agent-consult/session graph; " +
        "use openclaw/plugin-sdk/realtime-voice-activation for activation-name helpers",
      kinds: new Set(["doctor-contract", "legacy-setup"]),
    },
  ],
  [
    "openclaw/plugin-sdk/channel-outbound",
    {
      reason:
        "the channel-outbound barrel makes doctor enumeration cold-load the reply-pipeline/channel-registry graph; " +
        "use openclaw/plugin-sdk/channel-streaming-config for streaming config helpers",
      kinds: new Set(["doctor-contract"]),
    },
  ],
  [
    "openclaw/plugin-sdk/memory-host-core",
    {
      reason:
        "the memory-host barrel makes doctor enumeration cold-load the event-store/kysely graph; " +
        "use openclaw/plugin-sdk/agent-scope-runtime for agent scope resolvers",
      kinds: new Set(["doctor-contract", "legacy-setup"]),
    },
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
  kind: ClosureKind;
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
      FORBIDDEN_SPECIFIER_RULES.has(specifier) || specifier.startsWith("."),
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
    // A declaration listing no surface gates the artifact off every enumeration
    // path, exactly as `resolvePluginDoctorContracts` does, so its closure cost
    // is never paid. Absent declarations still load eagerly and are enforced.
    const declaresAnyDoctorSurface =
      !record.doctorContract ||
      Object.values(record.doctorContract).some((value) => value ?? false);
    if (doctorContractPath && declaresAnyDoctorSurface) {
      entries.push({
        pluginId: record.id,
        pluginRoot,
        entryPath: doctorContractPath,
        kind: "doctor-contract",
      });
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
        entries.push({ pluginId: record.id, pluginRoot, entryPath, kind: "legacy-setup" });
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
      const rule = FORBIDDEN_SPECIFIER_RULES.get(reference.specifier);
      if (rule?.kinds.has(entry.kind)) {
        violations.push(
          `${entry.pluginId}: ${formatRepoPath(filePath)}:${reference.line} imports ${reference.specifier}; ${rule.reason}`,
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

function collectHeavyRuntimeDoctorMigrationImports(): string[] {
  const entryPath = path.join(REPO_ROOT, "src/plugin-sdk/runtime-doctor-migrations.ts");
  const forbiddenPrefixes = ["src/plugin-state/plugin-state-store", "src/state/openclaw-state-db"];
  const violations: string[] = [];
  const visited = new Set<string>();
  const pending = [entryPath];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const reference of collectStaticValueReferences(filePath, source)) {
      if (!reference.specifier.startsWith(".")) {
        continue;
      }
      const resolvedPath = resolveRelativeSourceModule(filePath, reference.specifier);
      if (!resolvedPath || !isInsideRoot(REPO_ROOT, resolvedPath)) {
        continue;
      }
      const repoPath = formatRepoPath(resolvedPath);
      if (forbiddenPrefixes.some((prefix) => repoPath.startsWith(prefix))) {
        violations.push(
          `${formatRepoPath(filePath)}:${reference.line} reaches heavy doctor dependency ${repoPath}`,
        );
        continue;
      }
      pending.push(resolvedPath);
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

  it("keeps the runtime doctor migration helper off state DB and plugin-state graphs", () => {
    expect(collectHeavyRuntimeDoctorMigrationImports()).toStrictEqual([]);
  });
});
