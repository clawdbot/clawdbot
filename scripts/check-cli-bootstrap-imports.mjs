#!/usr/bin/env node

import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENTRYPOINTS = ["dist/entry.js", "dist/cli/run-main.js"];
const DEFAULT_GATEWAY_RUN_CHUNK_MAX_BYTES = 70 * 1024;
const GATEWAY_RUN_CHUNK_MARKERS = ["const GATEWAY_RUN_VALUE_KEYS", "function addGatewayRunCommand"];
const GATEWAY_RUN_FORBIDDEN_STATIC_IMPORTS = [
  "control-ui-assets",
  "diagnostic-stability-bundle",
  "onboard-helpers",
  "process-respawn",
  "restart-sentinel",
  "server-close",
  "server-reload-handlers",
];
const STATIC_IMPORT_RE =
  /\b(?:import|export)\s+(?:(?:[^'"()]*?\s+from\s+)|)["'](?<specifier>[^"']+)["']/gu;

function isMainModule() {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

function isBuiltinSpecifier(specifier) {
  return specifier.startsWith("node:") || module.isBuiltin(specifier);
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function resolveRelativeImport(importer, specifier, fsImpl = fs) {
  const base = specifier.startsWith("/")
    ? specifier
    : path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
    path.join(base, "index.cjs"),
  ];
  return candidates.find((candidate) => {
    try {
      return fsImpl.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function listStaticImportSpecifiers(source) {
  return [...source.matchAll(STATIC_IMPORT_RE)].map((match) => match.groups?.specifier ?? "");
}

function walkStaticImportGraph(params) {
  const { fsImpl, rootDir } = params;
  const queue = params.roots.map((entrypoint) => path.resolve(rootDir, entrypoint));
  const visited = new Set();
  const errors = [];

  for (let index = 0; index < queue.length; index += 1) {
    const filePath = queue[index];
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);

    let source;
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      errors.push(
        `CLI bootstrap import guard could not read ${path.relative(rootDir, filePath) || filePath}. Run pnpm build first.`,
      );
      continue;
    }
    for (const specifier of listStaticImportSpecifiers(source)) {
      if (!specifier || isBuiltinSpecifier(specifier)) {
        continue;
      }
      if (!isRelativeSpecifier(specifier)) {
        params.onExternalSpecifier?.({ filePath, specifier, errors });
        continue;
      }
      const resolved = resolveRelativeImport(filePath, specifier, fsImpl);
      if (!resolved) {
        errors.push(
          `CLI bootstrap import guard could not resolve "${specifier}" from ${path.relative(
            rootDir,
            filePath,
          )}.`,
        );
        continue;
      }
      params.onRelativeSpecifier?.({ filePath, resolved, specifier, errors });
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return errors;
}

export function collectCliBootstrapExternalImportErrors(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const entrypoints = params.entrypoints ?? DEFAULT_ENTRYPOINTS;
  const fsImpl = params.fs ?? fs;
  const errors = walkStaticImportGraph({
    fsImpl,
    rootDir,
    roots: entrypoints,
    onExternalSpecifier: ({ filePath, specifier, errors: graphErrors }) => {
      graphErrors.push(
        `CLI bootstrap static graph imports external package "${specifier}" from ${path.relative(
          rootDir,
          filePath,
        )}.`,
      );
    },
  });

  return errors.toSorted((left, right) => left.localeCompare(right));
}

function listJsFiles(dirPath, fsImpl = fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath, fsImpl));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

export function collectGatewayRunChunkBudgetErrors(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const distDir = path.resolve(rootDir, params.distDir ?? "dist");
  const maxBytes = params.gatewayRunChunkMaxBytes ?? DEFAULT_GATEWAY_RUN_CHUNK_MAX_BYTES;
  const chunks = [];

  for (const filePath of listJsFiles(distDir, fsImpl)) {
    let source;
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (GATEWAY_RUN_CHUNK_MARKERS.every((marker) => source.includes(marker))) {
      chunks.push({ filePath, source });
    }
  }

  if (chunks.length === 0) {
    return [
      "CLI bootstrap import guard could not find the bundled gateway run chunk. Run pnpm build first.",
    ];
  }

  const errors = [];
  for (const { filePath, source } of chunks) {
    const relativePath = path.relative(rootDir, filePath) || filePath;
    let size = Buffer.byteLength(source, "utf8");
    try {
      size = fsImpl.statSync(filePath).size;
    } catch {
      // Fall back to source byte length for in-memory test fixtures.
    }
    if (size > maxBytes) {
      errors.push(
        `Gateway run chunk ${relativePath} is ${size} bytes, above budget ${maxBytes} bytes.`,
      );
    }

    errors.push(
      ...walkStaticImportGraph({
        fsImpl,
        rootDir,
        roots: [filePath],
        onRelativeSpecifier: ({
          filePath: importerPath,
          resolved,
          specifier,
          errors: graphErrors,
        }) => {
          const resolvedRelativePath = path.relative(rootDir, resolved) || resolved;
          const coldPath = [specifier, resolvedRelativePath].find((candidate) =>
            GATEWAY_RUN_FORBIDDEN_STATIC_IMPORTS.some((forbidden) => candidate.includes(forbidden)),
          );
          if (!coldPath) {
            return;
          }
          graphErrors.push(
            `Gateway run chunk ${relativePath} static graph imports cold path "${coldPath}" from ${
              path.relative(rootDir, importerPath) || importerPath
            }.`,
          );
        },
      }),
    );
  }

  return errors.toSorted((left, right) => left.localeCompare(right));
}

export function checkCliBootstrapExternalImports(params = {}) {
  const errors = [
    ...collectCliBootstrapExternalImportErrors(params),
    ...collectGatewayRunChunkBudgetErrors(params),
  ];
  if (errors.length === 0) {
    return;
  }
  const logger = params.logger ?? console;
  logger.error("CLI bootstrap import guard failed:");
  for (const error of errors) {
    logger.error(`  - ${error}`);
  }
  throw new Error("CLI bootstrap static graph imports external packages.");
}

if (isMainModule()) {
  try {
    checkCliBootstrapExternalImports();
    console.log("CLI bootstrap import guard passed.");
  } catch {
    process.exit(1);
  }
}
