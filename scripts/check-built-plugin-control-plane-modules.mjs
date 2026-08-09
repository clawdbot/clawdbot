#!/usr/bin/env node

// Verifies built plugin control-plane artifacts through Node's native require(esm) path.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const ROOT = resolveRepoRoot(import.meta.url);
const DIRECT_CONTRACT_FILES = ["contract-api.js", "doctor-contract-api.js"];
const LEGACY_SETUP_PROPERTIES = new Map([
  ["legacyStateMigrations", "channel-legacy-state-migrations"],
  ["legacySessionSurface", "channel-legacy-session-surface"],
  ["legacySessionSurfaces", "channel-legacy-session-surface"],
]);
const PROBE_RESULT_MARKER = "__OPENCLAW_PLUGIN_CONTROL_PLANE_PROBE__";
const DEFAULT_TIMEOUT_MS = 120_000;
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

function propertyNameText(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

function listLegacySetupModuleSpecifiers(setupEntryPath) {
  const source = fs.readFileSync(setupEntryPath, "utf8");
  const sourceFile = ts.createSourceFile(setupEntryPath, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const visit = (node) => {
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
export function listBuiltPluginControlPlaneModules(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const extensionsDir = path.join(rootDir, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }
  const modules = new Map();
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
export function probeBuiltPluginControlPlaneModules(modules, params = {}) {
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
  const payload = JSON.parse(result.stdout.slice(markerIndex + PROBE_RESULT_MARKER.length));
  return Array.isArray(payload.failures) ? payload.failures : [];
}

/** Fails the build when a generated plugin control-plane module cannot be required natively. */
export function verifyBuiltPluginControlPlaneModules(params = {}) {
  const modules = listBuiltPluginControlPlaneModules(params);
  const failures = probeBuiltPluginControlPlaneModules(modules, params);
  if (failures.length > 0) {
    const details = failures.map(
      (failure) =>
        `- ${failure.pluginId} (${failure.kind}) ${failure.relativePath}: ${failure.error}`,
    );
    throw new Error(`built plugin control-plane module load failures:\n${details.join("\n")}`);
  }
  console.error(
    `[plugin-control-plane-loads] verified ${modules.length} built modules with native require`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  verifyBuiltPluginControlPlaneModules();
}
