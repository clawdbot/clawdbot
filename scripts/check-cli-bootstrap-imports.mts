#!/usr/bin/env node

// Checks CLI bootstrap chunks for forbidden eager imports and size regressions.
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { parse, type Node as AcornNode } from "acorn";
import {
  WORKER_BUNDLE_ENTRY_PATH,
  WORKER_BUNDLE_RSYNC_RECEIVER_PATH,
} from "../src/shared/worker-bundle-hash.js";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const DEFAULT_ENTRYPOINTS = ["dist/entry.js", "dist/cli/run-main.js"];
const WORKER_DEPLOY_ENTRYPOINTS = [
  `dist/worker/${WORKER_BUNDLE_ENTRY_PATH}`,
  `dist/worker/${WORKER_BUNDLE_RSYNC_RECEIVER_PATH}`,
] as const;
const DEFAULT_GATEWAY_RUN_CHUNK_MAX_BYTES = 70 * 1024;
const GATEWAY_RUN_CHUNK_MARKER_SETS = [
  ["const GATEWAY_AUTH_MODES", "function addGatewayRunCommand"],
  ["const GATEWAY_RUN_VALUE_KEYS", "function addGatewayRunCommand"],
];
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

type CliBootstrapCheckParams = {
  rootDir?: string;
  entrypoints?: string[];
  distDir?: string;
  gatewayRunChunkMaxBytes?: number;
  fs?: typeof fs;
  logger?: { error(message: string): void };
};

function isBuiltinSpecifier(specifier: string) {
  return specifier.startsWith("node:") || module.isBuiltin(specifier);
}

function isRelativeSpecifier(specifier: string) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function resolveRelativeImport(importer: string, specifier: string, fsImpl: typeof fs = fs) {
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

/**
 * Lists static import/export specifiers from a JavaScript source string.
 */
export function listStaticImportSpecifiers(source: string) {
  return [...source.matchAll(STATIC_IMPORT_RE)].map((match) => match.groups?.specifier ?? "");
}

function literalString(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const node = value as { type?: unknown; value?: unknown };
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function isRequireCallName(value: unknown): boolean {
  return typeof value === "string" && /^(?:require|_*require\d*)$/u.test(value);
}

function isRequireLikeCallee(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "Identifier") {
    return isRequireCallName(node.name);
  }
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (!callee || typeof callee !== "object" || Array.isArray(callee)) {
    return false;
  }
  const member = callee as Record<string, unknown>;
  if (member.type === "Identifier" && member.name === "createRequire") {
    return true;
  }
  const property = member.property;
  return (
    member.type === "MemberExpression" &&
    property !== null &&
    typeof property === "object" &&
    !Array.isArray(property) &&
    (property as Record<string, unknown>).type === "Identifier" &&
    (property as Record<string, unknown>).name === "createRequire"
  );
}

function listRuntimeImportSpecifiers(source: string): string[] {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  });
  const specifiers: string[] = [];
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") {
      continue;
    }
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const node = value as AcornNode & Record<string, unknown>;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ImportExpression"
    ) {
      const specifier = literalString(node.source);
      if (specifier) {
        specifiers.push(specifier);
      }
    } else if (node.type === "CallExpression") {
      const callee = node.callee;
      const args = node.arguments;
      if (isRequireLikeCallee(callee) && Array.isArray(args)) {
        const specifier = literalString(args[0]);
        if (specifier) {
          specifiers.push(specifier);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") {
        continue;
      }
      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return [...new Set(specifiers)].toSorted((left, right) => left.localeCompare(right));
}

function walkStaticImportGraph(
  fsImpl: typeof fs,
  rootDir: string,
  roots: string[],
  onExternalSpecifier?: (filePath: string, specifier: string) => string,
  onRelativeSpecifier?: (
    filePath: string,
    resolved: string,
    specifier: string,
  ) => string | undefined,
) {
  const queue = roots.map((entrypoint) => path.resolve(rootDir, entrypoint));
  const visited = new Set<string>();
  const errors = [];

  for (const filePath of queue) {
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
        const error = onExternalSpecifier?.(filePath, specifier);
        if (error) {
          errors.push(error);
        }
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
      const error = onRelativeSpecifier?.(filePath, resolved, specifier);
      if (error) {
        errors.push(error);
      }
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return errors;
}

/**
 * Collects forbidden external import errors for CLI bootstrap entrypoints.
 */
export function collectCliBootstrapExternalImportErrors(params: CliBootstrapCheckParams = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const entrypoints = params.entrypoints ?? DEFAULT_ENTRYPOINTS;
  const fsImpl = params.fs ?? fs;
  const errors = walkStaticImportGraph(
    fsImpl,
    rootDir,
    entrypoints,
    (filePath, specifier) =>
      `CLI bootstrap static graph imports external package "${specifier}" from ${path.relative(
        rootDir,
        filePath,
      )}.`,
  );

  return errors.toSorted((left, right) => left.localeCompare(right));
}

function listJsFiles(dirPath: string, fsImpl: typeof fs = fs): string[] {
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

/**
 * Collects gateway-run chunk budget errors from built CLI output.
 */
export function collectGatewayRunChunkBudgetErrors(params: CliBootstrapCheckParams = {}) {
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
    if (
      GATEWAY_RUN_CHUNK_MARKER_SETS.some((markers) =>
        markers.every((marker) => source.includes(marker)),
      )
    ) {
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
      ...walkStaticImportGraph(
        fsImpl,
        rootDir,
        [filePath],
        undefined,
        (importerPath, resolved, specifier) => {
          const resolvedRelativePath = path.relative(rootDir, resolved) || resolved;
          const coldPath = [specifier, resolvedRelativePath].find((candidate) =>
            GATEWAY_RUN_FORBIDDEN_STATIC_IMPORTS.some((forbidden) => candidate.includes(forbidden)),
          );
          return coldPath
            ? `Gateway run chunk ${relativePath} static graph imports cold path "${coldPath}" from ${
                path.relative(rootDir, importerPath) || importerPath
              }.`
            : undefined;
        },
      ),
    );
  }

  return errors.toSorted((left, right) => left.localeCompare(right));
}

/** Collects closure and layout errors for the standalone worker deploy artifact. */
export function collectWorkerDeployArtifactErrors(params: CliBootstrapCheckParams = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const entrypoints = WORKER_DEPLOY_ENTRYPOINTS.map((entrypoint) =>
    path.resolve(rootDir, entrypoint),
  );
  const artifactDir = path.dirname(entrypoints[0]!);
  const artifactNames = new Set(
    entrypoints.flatMap((entrypoint) => {
      const name = path.basename(entrypoint);
      return [name, `${name}.map`];
    }),
  );
  const errors: string[] = [];
  const sources: Array<{ relativeEntrypoint: string; source: string }> = [];
  for (const entrypoint of entrypoints) {
    const relativeEntrypoint = path.relative(rootDir, entrypoint) || entrypoint;
    try {
      const stats = fsImpl.lstatSync(entrypoint);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        return [`Worker deploy artifact ${relativeEntrypoint} must be a regular file.`];
      }
      sources.push({
        relativeEntrypoint,
        source: fsImpl.readFileSync(entrypoint, "utf8"),
      });
    } catch {
      return [`Worker deploy artifact ${relativeEntrypoint} is missing. Run pnpm build first.`];
    }
  }
  try {
    for (const entry of fsImpl.readdirSync(artifactDir, { withFileTypes: true })) {
      if (artifactNames.has(entry.name)) {
        continue;
      }
      if (entry.name === "package.json") {
        errors.push(
          "Worker deploy artifact must not contain a dependency manifest or lifecycle scripts.",
        );
      } else if (entry.name === "node_modules") {
        errors.push("Worker deploy artifact must not contain materialized dependencies.");
      } else if (/\.(?:mjs|node|wasm)$/u.test(entry.name)) {
        errors.push(
          `Worker deploy artifact emits unstaged runtime asset ${path.relative(
            rootDir,
            path.join(artifactDir, entry.name),
          )}.`,
        );
      }
    }
  } catch {
    errors.push(
      `Worker deploy artifact directory ${path.relative(rootDir, artifactDir)} is unreadable.`,
    );
  }
  for (const { relativeEntrypoint, source } of sources) {
    try {
      for (const specifier of listRuntimeImportSpecifiers(source)) {
        if (isBuiltinSpecifier(specifier)) {
          continue;
        }
        errors.push(
          `Worker deploy artifact ${relativeEntrypoint} retains runtime import "${specifier}" instead of bundling it.`,
        );
      }
    } catch (error) {
      errors.push(
        `Worker deploy artifact ${relativeEntrypoint} is not parseable JavaScript: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
    }
  }
  return errors.toSorted((left, right) => left.localeCompare(right));
}

/**
 * Runs the CLI bootstrap import, chunk-budget, and worker deploy checks.
 */
export function checkCliBootstrapExternalImports(params: CliBootstrapCheckParams = {}) {
  const errors = [
    ...collectCliBootstrapExternalImportErrors(params),
    ...collectGatewayRunChunkBudgetErrors(params),
    ...collectWorkerDeployArtifactErrors(params),
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

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    checkCliBootstrapExternalImports();
    console.log("CLI bootstrap import guard passed.");
  } catch {
    process.exit(1);
  }
}
