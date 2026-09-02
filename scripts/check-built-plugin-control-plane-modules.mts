#!/usr/bin/env node

// Verifies built plugin control-plane artifacts through Node's native require(esm) path.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { isRecord } from "./lib/record-shared.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

type BuiltPluginControlPlaneModule = {
  pluginId: string;
  kind: string;
  relativePath: string;
};

type BuiltPluginControlPlaneModuleFailure = BuiltPluginControlPlaneModule & {
  error: string;
};

type BuiltDoctorContractClosureViolation = BuiltPluginControlPlaneModule & {
  dependency: string;
  importerPath: string;
};

type ProbeParams = {
  rootDir?: string;
  timeoutMs?: number;
};

const ROOT = resolveRepoRoot(import.meta.url);
const DIRECT_CONTRACT_FILES = ["contract-api.js", "doctor-contract-api.js"];
const LEGACY_SETUP_PROPERTIES = new Map<string, string>([
  ["legacyStateMigrations", "channel-legacy-state-migrations"],
  ["legacySessionSurface", "channel-legacy-session-surface"],
  ["legacySessionSurfaces", "channel-legacy-session-surface"],
]);
const PROBE_RESULT_MARKER = "__OPENCLAW_PLUGIN_CONTROL_PLANE_PROBE__";
const DEFAULT_TIMEOUT_MS = 120_000;
// Doctor enumeration cold-loads every declaring plugin's contract closure, so a
// doctor artifact must never reach the process-spawn graph. Requiring the artifact
// cannot prove this: plain Node resolves the whole graph fine, and the cost and the
// ESM-only transitive deps (execa -> npm-run-path -> unicorn-magic, which has no
// `require` condition) only surface on source-run hosts whose CJS-flavored resolver
// rejects them. `doctor-contract-closure-guard.test.ts` owns the same invariant over
// sources; bundling can merge runtime code into the artifact behind its back, so the
// built closure is checked here.
const FORBIDDEN_DOCTOR_CONTRACT_DEPENDENCIES = ["execa"];
const REQUIRE_PROBE_SOURCE = String.raw`
const { createRequire } = require("node:module");
const path = require("node:path");
const targets = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const requireFromRoot = createRequire(path.join(process.cwd(), "package.json"));
const failures = [];
for (const target of targets) {
  try {
    requireFromRoot(path.resolve(process.cwd(), target.relativePath));
  } catch (error) {
    failures.push({
      ...target,
      error: error instanceof Error ? (error.stack || error.message) : String(error),
    });
  }
}
process.stdout.write("\n${PROBE_RESULT_MARKER}" + JSON.stringify({ failures }));
`;

function propertyNameText(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : "";
}

function listLegacySetupModuleSpecifiers(setupEntryPath: string) {
  const source = fs.readFileSync(setupEntryPath, "utf8");
  const sourceFile = ts.createSourceFile(setupEntryPath, source, ts.ScriptTarget.Latest, true);
  const specifiers: Array<{ kind: string; specifier: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) {
      const kind = LEGACY_SETUP_PROPERTIES.get(propertyNameText(node.name));
      if (kind) {
        const specifierProperty = node.initializer.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) && propertyNameText(property.name) === "specifier",
        );
        if (
          specifierProperty &&
          ts.isPropertyAssignment(specifierProperty) &&
          ts.isStringLiteralLike(specifierProperty.initializer)
        ) {
          specifiers.push({ kind, specifier: specifierProperty.initializer.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** Lists exact built doctor, contract, and channel legacy migration artifacts. */
export function listBuiltPluginControlPlaneModules(params: { rootDir?: string } = {}) {
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const extensionsDir = path.join(rootDir, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }
  const modules = new Map<string, BuiltPluginControlPlaneModule>();
  for (const entry of fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory())
    .toSorted((left, right) => left.name.localeCompare(right.name))) {
    const pluginId = entry.name;
    const pluginDir = path.join(extensionsDir, pluginId);
    for (const fileName of DIRECT_CONTRACT_FILES) {
      const modulePath = path.join(pluginDir, fileName);
      if (fs.existsSync(modulePath)) {
        const relativePath = path.relative(rootDir, modulePath).split(path.sep).join("/");
        modules.set(relativePath, {
          pluginId,
          kind: fileName === "doctor-contract-api.js" ? "doctor-contract" : "contract",
          relativePath,
        });
      }
    }
    const setupEntryPath = path.join(pluginDir, "setup-entry.js");
    if (!fs.existsSync(setupEntryPath)) {
      continue;
    }
    for (const { kind, specifier } of listLegacySetupModuleSpecifiers(setupEntryPath)) {
      const modulePath = path.resolve(pluginDir, specifier);
      const pluginRelativePath = path.relative(pluginDir, modulePath);
      if (pluginRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(pluginRelativePath)) {
        throw new Error(`${pluginId} setup entry module escapes the plugin root: ${specifier}`);
      }
      const relativePath = path.relative(rootDir, modulePath).split(path.sep).join("/");
      modules.set(relativePath, { pluginId, kind, relativePath });
    }
  }
  return [...modules.values()].toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

/** Loads every selected artifact in one timeout-bounded native-require child. */
export function probeBuiltPluginControlPlaneModules(
  modules: BuiltPluginControlPlaneModule[],
  params: ProbeParams = {},
) {
  if (modules.length === 0) {
    return [];
  }
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const encodedTargets = Buffer.from(JSON.stringify(modules), "utf8").toString("base64url");
  const result = spawnSync(process.execPath, ["-e", REQUIRE_PROBE_SOURCE, encodedTargets], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(
      `built plugin control-plane native-require probe failed: ${result.error.message}`,
    );
  }
  const markerIndex = result.stdout.lastIndexOf(PROBE_RESULT_MARKER);
  if (markerIndex < 0) {
    throw new Error(
      `built plugin control-plane native-require probe exited ${String(result.status)} without a result`,
    );
  }
  const payload: unknown = JSON.parse(
    result.stdout.slice(markerIndex + PROBE_RESULT_MARKER.length),
  );
  if (!isRecord(payload) || !Array.isArray(payload.failures)) {
    return [];
  }
  return payload.failures.filter(
    (failure): failure is BuiltPluginControlPlaneModuleFailure =>
      isRecord(failure) &&
      typeof failure.pluginId === "string" &&
      typeof failure.kind === "string" &&
      typeof failure.relativePath === "string" &&
      typeof failure.error === "string",
  );
}

// Built chunks are plain ESM, so static edges are exactly the import/export
// declarations. Dynamic `import()` is excluded by construction: a lazy edge is
// never paid at enumeration time.
function parseStaticModuleSpecifiers(source: string, filePath: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}

function resolveBuiltChunkPath(importerPath: string, specifier: string): string | undefined {
  const target = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [target, `${target}.js`, `${target}.mjs`, path.join(target, "index.js")];
  return candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
}

/** Collects the bare dependencies a built artifact reaches through static imports. */
function collectBuiltModuleStaticDependencies(entryPath: string): Map<string, string> {
  const dependencies = new Map<string, string>();
  const visited = new Set<string>();
  const pending: string[] = [entryPath];
  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);
    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const reference of parseStaticModuleSpecifiers(source, filePath)) {
      if (reference.startsWith(".") || reference.startsWith("/")) {
        const resolved = resolveBuiltChunkPath(filePath, reference);
        if (resolved) {
          pending.push(resolved);
        }
        continue;
      }
      if (!reference.startsWith("node:") && !dependencies.has(reference)) {
        dependencies.set(reference, filePath);
      }
    }
  }
  return dependencies;
}

/** Fails when a built doctor artifact statically reaches a forbidden runtime dependency. */
export function collectBuiltDoctorContractClosureViolations(
  modules: BuiltPluginControlPlaneModule[],
  params: { rootDir?: string } = {},
): BuiltDoctorContractClosureViolation[] {
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const violations: BuiltDoctorContractClosureViolation[] = [];
  for (const module of modules.filter((candidate) => candidate.kind === "doctor-contract")) {
    const dependencies = collectBuiltModuleStaticDependencies(
      path.join(rootDir, module.relativePath),
    );
    for (const dependency of FORBIDDEN_DOCTOR_CONTRACT_DEPENDENCIES) {
      const importer = dependencies.get(dependency);
      if (importer) {
        violations.push({
          ...module,
          dependency,
          importerPath: path.relative(rootDir, importer).split(path.sep).join("/"),
        });
      }
    }
  }
  return violations;
}

/** Fails the build when a generated plugin control-plane module cannot be required natively. */
export function verifyBuiltPluginControlPlaneModules(params: ProbeParams = {}) {
  const modules = listBuiltPluginControlPlaneModules(params);
  const failures = probeBuiltPluginControlPlaneModules(modules, params);
  if (failures.length > 0) {
    const details = failures.map(
      (failure) =>
        `- ${failure.pluginId} (${failure.kind}) ${failure.relativePath}: ${failure.error}`,
    );
    throw new Error(`built plugin control-plane module load failures:\n${details.join("\n")}`);
  }
  const closureViolations = collectBuiltDoctorContractClosureViolations(modules, params);
  if (closureViolations.length > 0) {
    const details = closureViolations.map(
      (violation) =>
        `- ${violation.pluginId} ${violation.relativePath} statically reaches ${violation.dependency} through ${violation.importerPath}`,
    );
    throw new Error(
      `built doctor contract closures reach forbidden runtime dependencies:\n${details.join("\n")}`,
    );
  }
  console.error(
    `[plugin-control-plane-loads] verified ${modules.length} built modules with native require and checked doctor closures`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  verifyBuiltPluginControlPlaneModules();
}
