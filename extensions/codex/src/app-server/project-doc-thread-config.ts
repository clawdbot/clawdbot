import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type { CodexTurnEnvironmentParams, JsonObject } from "./protocol.js";

const CODEX_NATIVE_PROJECT_DOC_MAX_BYTES = 128 * 1024;
const CODEX_NATIVE_PROJECT_DOC_FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;
const CODEX_NATIVE_PROJECT_ROOT_MARKERS = [".git"] as const;
const CODEX_PROJECT_DOC_PREFLIGHT_CONCURRENCY = 32;

type CodexNativeProjectInstructionFile = {
  path: string;
  content: string;
};

export function buildCodexProjectDocThreadConfig(config?: JsonObject): JsonObject {
  const defaults: JsonObject = { project_doc_max_bytes: CODEX_NATIVE_PROJECT_DOC_MAX_BYTES };
  return mergeCodexThreadConfigs(defaults, config) ?? defaults;
}

export type CodexNativeProjectInstructionSourceIdentitySnapshot = {
  identities: ReadonlyMap<string, Stats>;
  environmentCwds: readonly string[];
};

/**
 * Records the bounded set of project-document candidates that Codex can select
 * for every host-local environment. The response remains authoritative about
 * which candidates were selected; a selected path without a baseline fails closed.
 */
export async function snapshotCodexNativeProjectInstructionSourceIdentities(params: {
  cwd: string;
  config?: JsonObject;
  environmentSelection?: readonly CodexTurnEnvironmentParams[];
  readNativeConfig?: (cwd: string) => Promise<unknown>;
}): Promise<CodexNativeProjectInstructionSourceIdentitySnapshot> {
  const environmentCwds = resolveCodexProjectInstructionEnvironmentCwds(params);
  const nativeConfigResponse = await params.readNativeConfig?.(path.resolve(params.cwd));
  let nativeConfig: JsonObject | undefined;
  let nativeConfigLayers: unknown[] | undefined;
  if (nativeConfigResponse !== undefined) {
    if (
      !isJsonObject(nativeConfigResponse) ||
      !isJsonObject(nativeConfigResponse.config) ||
      !Array.isArray(nativeConfigResponse.layers)
    ) {
      throw new Error("Codex config/read returned an invalid effective project-doc config");
    }
    nativeConfig = nativeConfigResponse.config;
    nativeConfigLayers = nativeConfigResponse.layers;
  }
  // Codex resolves one effective Config from the thread's primary cwd and uses
  // that same Config while loading project documents in every selected environment.
  const effectiveConfig = mergeCodexThreadConfigs(nativeConfig, params.config);
  const candidateFilenames = new Set([
    ...resolveCodexProjectDocCandidateFilenames(nativeConfig),
    ...resolveCodexProjectDocCandidateFilenames(effectiveConfig),
  ]);
  const nativeRootMarkerConfig =
    nativeConfigLayers === undefined
      ? params.config
      : resolveCodexNativeProjectRootMarkerConfig(nativeConfigLayers);
  const rootMarkerSets = [resolveCodexProjectRootMarkers(nativeRootMarkerConfig)];
  if (
    nativeConfigLayers !== undefined &&
    params.config &&
    Object.hasOwn(params.config, "project_root_markers")
  ) {
    rootMarkerSets.push(resolveCodexProjectRootMarkers(params.config));
  }
  const candidatePaths = new Set<string>();
  for (const cwd of environmentCwds) {
    for (const rootMarkers of dedupeStringLists(rootMarkerSets)) {
      const directories = await resolveCodexProjectDocSearchDirectories(cwd, rootMarkers);
      for (const directory of directories) {
        for (const filename of candidateFilenames) {
          candidatePaths.add(path.resolve(directory, filename));
        }
      }
    }
  }
  const identities = new Map<string, CodexProjectDocIdentity>();
  await forEachWithConcurrency(
    [...candidatePaths],
    CODEX_PROJECT_DOC_PREFLIGHT_CONCURRENCY,
    async (filePath) => {
      try {
        const identity = await fs.stat(filePath);
        if (identity.isFile()) {
          identities.set(filePath, identity);
        }
      } catch {
        // An unrelated broken or inaccessible entry must not block startup.
        // If Codex selects it, the missing baseline below still fails closed.
      }
    },
  );
  return { identities, environmentCwds };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Freezes the project-document sources selected by Codex for this thread.
 * Source selection remains owned by Codex, including configured root markers,
 * override precedence, and fallback filenames. Capture fails closed if a selected
 * local source changed after the native start request began.
 */
export async function captureCodexNativeProjectInstructions(params: {
  cwd: string;
  instructionSources: readonly string[];
  config?: JsonObject;
  sourceIdentitiesBeforeRequest: CodexNativeProjectInstructionSourceIdentitySnapshot;
}): Promise<string | undefined> {
  const files = await readCodexNativeProjectInstructionFiles({
    environmentCwds: params.sourceIdentitiesBeforeRequest.environmentCwds,
    instructionSources: params.instructionSources,
    maxBytes: params.config?.project_doc_max_bytes,
    sourceIdentitiesBeforeRequest: params.sourceIdentitiesBeforeRequest,
  });
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "## OpenClaw Agent Workspace Instructions",
    "",
    "OpenClaw froze the Codex-selected root-to-working-directory project instructions that established this thread.",
    "",
  ];
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

async function readCodexNativeProjectInstructionFiles(params: {
  environmentCwds: readonly string[];
  instructionSources: readonly string[];
  maxBytes?: unknown;
  sourceIdentitiesBeforeRequest: CodexNativeProjectInstructionSourceIdentitySnapshot;
}): Promise<CodexNativeProjectInstructionFile[]> {
  let remaining = normalizeProjectDocMaxBytes(params.maxBytes);
  if (remaining === 0) {
    return [];
  }
  const files: CodexNativeProjectInstructionFile[] = [];
  const seen = new Set<string>();
  for (const source of params.instructionSources) {
    const filePath = path.resolve(source);
    if (
      remaining === 0 ||
      seen.has(filePath) ||
      !params.environmentCwds.some((cwd) => isProjectInstructionSource(filePath, cwd))
    ) {
      continue;
    }
    seen.add(filePath);
    const content = await readCodexProjectDoc(
      filePath,
      remaining,
      params.sourceIdentitiesBeforeRequest,
    );
    if (!content.text.trim()) {
      continue;
    }
    files.push({ path: filePath, content: content.text });
    remaining = Math.max(0, remaining - content.bytesRead);
  }
  return files;
}

function normalizeProjectDocMaxBytes(value: unknown): number {
  if (value === undefined) {
    return CODEX_NATIVE_PROJECT_DOC_MAX_BYTES;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function resolveCodexProjectInstructionEnvironmentCwds(params: {
  cwd: string;
  environmentSelection?: readonly CodexTurnEnvironmentParams[];
}): string[] {
  const environmentCwds = new Set<string>([path.resolve(params.cwd)]);
  for (const environment of params.environmentSelection ?? []) {
    if (typeof environment.cwd === "string" && environment.cwd.trim()) {
      environmentCwds.add(path.resolve(environment.cwd));
    }
  }
  return [...environmentCwds];
}

function resolveCodexProjectDocCandidateFilenames(config?: JsonObject): string[] {
  const filenames = new Set<string>(CODEX_NATIVE_PROJECT_DOC_FILENAMES);
  const configured = config?.project_doc_fallback_filenames;
  if (Array.isArray(configured)) {
    for (const value of configured) {
      if (typeof value === "string" && value.length > 0) {
        filenames.add(value);
      }
    }
  }
  return [...filenames];
}

function resolveCodexProjectRootMarkers(config?: JsonObject): string[] {
  const configured = config?.project_root_markers;
  if (configured === undefined || !Array.isArray(configured)) {
    return [...CODEX_NATIVE_PROJECT_ROOT_MARKERS];
  }
  if (!configured.every((value): value is string => typeof value === "string")) {
    return [...CODEX_NATIVE_PROJECT_ROOT_MARKERS];
  }
  return [...configured];
}

function resolveCodexNativeProjectRootMarkerConfig(
  nativeConfigLayers: readonly unknown[],
): JsonObject | undefined {
  // config/read layers are highest-precedence first. Codex intentionally
  // excludes project layers when resolving the directory-search boundary.
  for (const layer of nativeConfigLayers) {
    if (!isJsonObject(layer)) {
      throw new Error("Codex config/read returned an invalid project-doc config layer");
    }
    if (layer.disabledReason !== undefined && layer.disabledReason !== null) {
      if (typeof layer.disabledReason !== "string") {
        throw new Error("Codex config/read returned an invalid disabled project-doc config layer");
      }
      continue;
    }
    if (
      !isJsonObject(layer.name) ||
      typeof layer.name.type !== "string" ||
      !isJsonObject(layer.config)
    ) {
      throw new Error("Codex config/read returned an invalid project-doc config layer");
    }
    if (layer.name.type !== "project" && Object.hasOwn(layer.config, "project_root_markers")) {
      return layer.config;
    }
  }
  return undefined;
}

function dedupeStringLists(values: readonly string[][]): string[][] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function resolveCodexProjectDocSearchDirectories(
  cwd: string,
  rootMarkers: readonly string[],
): Promise<string[]> {
  const resolvedCwd = path.resolve(cwd);
  if (rootMarkers.length === 0) {
    return [resolvedCwd];
  }
  const ancestors = [resolvedCwd];
  let directory = resolvedCwd;
  while (true) {
    const containsRootMarker = await Promise.all(
      rootMarkers.map(async (marker) => {
        try {
          await fs.stat(path.resolve(directory, marker));
          return true;
        } catch {
          return false;
        }
      }),
    ).then((results) => results.some(Boolean));
    if (containsRootMarker) {
      return ancestors.toReversed();
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return [resolvedCwd];
    }
    ancestors.push(parent);
    directory = parent;
  }
}

async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        if (value !== undefined) {
          await visit(value);
        }
      }
    }),
  );
}

function isProjectInstructionSource(filePath: string, cwd: string): boolean {
  const relative = path.relative(path.dirname(filePath), cwd);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function readCodexProjectDoc(
  filePath: string,
  maxBytes: number,
  sourceIdentitiesBeforeRequest: CodexNativeProjectInstructionSourceIdentitySnapshot,
): Promise<{ text: string; bytesRead: number }> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const identityBefore = await handle.stat();
    assertCodexProjectDocFile(filePath, identityBefore);
    const identityBeforeRequest = sourceIdentitiesBeforeRequest.identities.get(filePath);
    if (!identityBeforeRequest) {
      throw new Error(
        `Codex-selected project instruction source was not present before native startup: ${filePath}`,
      );
    }
    assertSameCodexProjectDocIdentity(
      filePath,
      identityBeforeRequest,
      identityBefore,
      "during native startup",
    );
    const data = Buffer.allocUnsafe(maxBytes);
    let bytesRead = 0;
    while (bytesRead < maxBytes) {
      const result = await handle.read(data, bytesRead, maxBytes - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const identityAfter = await handle.stat();
    const pathIdentityAfter = await fs.stat(filePath);
    assertSameCodexProjectDocIdentity(filePath, identityBefore, identityAfter);
    assertSameCodexProjectDocIdentity(filePath, identityBefore, pathIdentityAfter);
    return { text: data.subarray(0, bytesRead).toString("utf8"), bytesRead };
  } finally {
    await handle?.close();
  }
}

type CodexProjectDocIdentity = Stats;

function assertCodexProjectDocFile(filePath: string, identity: CodexProjectDocIdentity) {
  if (!identity.isFile()) {
    throw new Error(`Codex-selected project instruction source is not a file: ${filePath}`);
  }
}

function assertSameCodexProjectDocIdentity(
  filePath: string,
  before: CodexProjectDocIdentity,
  after: CodexProjectDocIdentity,
  phase = "during capture",
) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`Codex-selected project instruction source changed ${phase}: ${filePath}`);
  }
}
