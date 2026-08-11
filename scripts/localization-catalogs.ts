import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type LocalizationCatalog,
  validateCatalog,
} from "../packages/localization-core/src/catalog.js";
import { SUPPORTED_LOCALES } from "../packages/localization-core/src/locale-registry.js";

export type CatalogTarget = {
  locale: string;
  path: string;
};

export type CatalogArea = {
  id: string;
  owner: string;
  namespace: string;
  source: string;
  targets: readonly CatalogTarget[];
  protectedLiterals: readonly string[];
};

export type CatalogRegistry = {
  schemaVersion: 1;
  areas: readonly CatalogArea[];
};

export type CatalogRefreshLimits = {
  maxAreas: number;
  maxTargets: number;
  maxMessagesPerArea: number;
  maxCharactersPerMessage: number;
  maxSourceCharactersPerArea: number;
  maxTranslationCharacters: number;
};

type SourceCatalog = {
  schemaVersion: 1;
  area: string;
  messages: Record<string, string>;
};

type GeneratedCatalog = SourceCatalog & {
  locale: string;
  sourceMessages: Record<string, string>;
  sourceRevision: string;
  generation: {
    workflow: string;
    provider: string;
    model: string;
    sourceCommit: string;
    glossaryRevision: string;
    validation: "passed";
  };
};

export type CatalogTranslator = (
  entries: readonly { id: string; source: string; sourcePath: string }[],
  locale: string,
) => Promise<Map<string, string>>;

const DEFAULT_REGISTRY_PATH = "localization/catalogs.json";
const DEFAULT_REFRESH_LIMITS: CatalogRefreshLimits = Object.freeze({
  maxAreas: 5,
  maxTargets: 110,
  maxMessagesPerArea: 500,
  maxCharactersPerMessage: 4_000,
  maxSourceCharactersPerArea: 100_000,
  maxTranslationCharacters: 2_000_000,
});

class CatalogSourceDriftError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectRepositoryPath(value: unknown, label: string): string {
  const candidate = expectString(value, label);
  if (
    candidate.includes("\\") ||
    /^[A-Za-z]:\//u.test(candidate) ||
    path.isAbsolute(candidate) ||
    path.posix.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate ||
    candidate === "." ||
    candidate.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return candidate;
}

function expectStringMap(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, expectString(entry, `${label}.${key}`)]),
  );
}

async function resolveRepositoryFile(
  root: string,
  relativePath: string,
  options: { allowMissing: boolean },
): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = path.resolve(canonicalRoot, relativePath);
  const relative = path.relative(canonicalRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${relativePath} must resolve inside the repository root`);
  }
  let current = canonicalRoot;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`${relativePath} must not traverse a symbolic link`);
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new Error(`${relativePath} has a non-directory parent`);
      }
      if (index === segments.length - 1 && !stats.isFile()) {
        throw new Error(`${relativePath} must be a regular file`);
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT" && options.allowMissing) {
        return candidate;
      }
      throw error;
    }
  }
  return candidate;
}

async function readJson(root: string, relativePath: string): Promise<unknown> {
  const filePath = await resolveRepositoryFile(root, relativePath, { allowMissing: false });
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readRegistry(root: string, registryPath: string): Promise<CatalogRegistry> {
  const raw = await readJson(root, registryPath);
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.areas)) {
    throw new Error("localization catalog registry must use schemaVersion 1 and declare areas");
  }
  if (raw.areas.length === 0) {
    throw new Error("localization catalog registry must declare at least one area");
  }
  const areas = raw.areas.map((entry, index): CatalogArea => {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.targets) ||
      !Array.isArray(entry.protectedLiterals)
    ) {
      throw new Error(`localization catalog registry area ${index} is malformed`);
    }
    if (entry.targets.length === 0) {
      throw new Error(`localization catalog registry area ${index} must declare a target`);
    }
    return {
      id: expectString(entry.id, `areas[${index}].id`),
      owner: expectString(entry.owner, `areas[${index}].owner`),
      namespace: expectString(entry.namespace, `areas[${index}].namespace`),
      source: expectRepositoryPath(entry.source, `areas[${index}].source`),
      targets: entry.targets.map((target, targetIndex) => {
        if (!isRecord(target)) {
          throw new Error(`areas[${index}].targets[${targetIndex}] is malformed`);
        }
        return {
          locale: expectString(target.locale, `areas[${index}].targets[${targetIndex}].locale`),
          path: expectRepositoryPath(target.path, `areas[${index}].targets[${targetIndex}].path`),
        };
      }),
      protectedLiterals: entry.protectedLiterals.map((literal, literalIndex) =>
        expectString(literal, `areas[${index}].protectedLiterals[${literalIndex}]`),
      ),
    };
  });
  const ids = new Set(areas.map((area) => area.id));
  if (ids.size !== areas.length) {
    throw new Error("localization catalog registry contains duplicate area ids");
  }
  const sourcePaths = areas.map((area) => area.source);
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    throw new Error("localization catalog registry contains duplicate source paths");
  }
  const targetPaths = areas.flatMap((area) => area.targets.map((target) => target.path));
  if (new Set(targetPaths).size !== targetPaths.length) {
    throw new Error("localization catalog registry contains duplicate target paths");
  }
  for (const area of areas) {
    if (!/(?:^|\/)i18n\/catalogs\/en\.json$/u.test(area.source)) {
      throw new Error(`${area.source} must use the adopted i18n/catalogs/en.json source path`);
    }
    const catalogDirectory = path.posix.dirname(area.source);
    const locales = new Set<string>();
    for (const target of area.targets) {
      if (!(SUPPORTED_LOCALES as readonly string[]).includes(target.locale)) {
        throw new Error(`area ${area.id} uses unsupported locale ${target.locale}`);
      }
      if (locales.has(target.locale)) {
        throw new Error(`area ${area.id} contains duplicate target locale ${target.locale}`);
      }
      locales.add(target.locale);
      const expectedPath = `${catalogDirectory}/generated/${target.locale}.json`;
      if (target.path !== expectedPath) {
        throw new Error(`${target.path} must be the owner-local generated target ${expectedPath}`);
      }
      if (target.path === area.source) {
        throw new Error(`area ${area.id} source and target paths must differ`);
      }
    }
  }
  return { schemaVersion: 1, areas };
}

export async function loadCatalogRegistry(
  options: { root?: string; registryPath?: string } = {},
): Promise<CatalogRegistry> {
  const root = options.root ?? process.cwd();
  return await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
}

export async function catalogWorkflowPaths(
  options: {
    root?: string;
    registryPath?: string;
    area?: string;
    areas?: readonly string[];
  } = {},
): Promise<{ sources: readonly string[]; targets: readonly string[] }> {
  const root = options.root ?? process.cwd();
  const registry = await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const areas = selectAreas(registry, options.area, options.areas);
  return {
    sources: Object.freeze(areas.map((area) => area.source).toSorted()),
    targets: Object.freeze(
      areas.flatMap((area) => area.targets.map((target) => target.path)).toSorted(),
    ),
  };
}

export async function catalogWorkflowAreas(
  options: { root?: string; registryPath?: string } = {},
): Promise<readonly string[]> {
  const root = options.root ?? process.cwd();
  const registry = await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
  return Object.freeze(registry.areas.map((area) => area.id).toSorted());
}

async function readSource(root: string, area: CatalogArea): Promise<SourceCatalog> {
  const raw = await readJson(root, area.source);
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.area !== area.id) {
    throw new Error(`${area.source} must declare schemaVersion 1 and area ${area.id}`);
  }
  return {
    schemaVersion: 1,
    area: area.id,
    messages: expectStringMap(raw.messages, `${area.id}.messages`),
  };
}

async function readGenerated(
  root: string,
  area: CatalogArea,
  target: CatalogTarget,
): Promise<GeneratedCatalog> {
  const raw = await readJson(root, target.path);
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.area !== area.id ||
    raw.locale !== target.locale ||
    !isRecord(raw.generation)
  ) {
    throw new Error(`${target.path} has invalid generated catalog identity`);
  }
  const workflow = expectString(raw.generation.workflow, `${target.path}.generation.workflow`);
  const sourceCommit = expectString(
    raw.generation.sourceCommit,
    `${target.path}.generation.sourceCommit`,
  );
  if (workflow !== "bootstrap-reviewed" && !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error(`${target.path}.generation.sourceCommit must be an exact source commit`);
  }
  if (raw.generation.validation !== "passed") {
    throw new Error(`${target.path}.generation.validation must be passed`);
  }
  return {
    schemaVersion: 1,
    area: area.id,
    locale: target.locale,
    sourceRevision: expectString(raw.sourceRevision, `${target.path}.sourceRevision`),
    generation: {
      workflow,
      provider: expectString(raw.generation.provider, `${target.path}.generation.provider`),
      model: expectString(raw.generation.model, `${target.path}.generation.model`),
      sourceCommit,
      glossaryRevision: expectString(
        raw.generation.glossaryRevision,
        `${target.path}.generation.glossaryRevision`,
      ),
      validation: "passed",
    },
    sourceMessages: expectStringMap(raw.sourceMessages, `${target.path}.sourceMessages`),
    messages: expectStringMap(raw.messages, `${target.path}.messages`),
  };
}

export function catalogSourceRevision(messages: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(messages).toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function validateGeneratedContent(area: CatalogArea, generated: GeneratedCatalog): void {
  const evidenceRevision = catalogSourceRevision(generated.sourceMessages);
  if (generated.sourceRevision !== evidenceRevision) {
    throw new Error(
      `${generated.locale}/${area.id} has invalid source evidence: expected ${evidenceRevision}, received ${generated.sourceRevision}`,
    );
  }
  const issues = validateCatalog({
    namespace: area.namespace,
    source: generated.sourceMessages satisfies LocalizationCatalog,
    candidate: generated.messages satisfies LocalizationCatalog,
  });
  if (issues.length > 0) {
    throw new Error(
      `${generated.locale}/${area.id} failed catalog validation:
${issues.map((issue) => `- ${issue.code} ${issue.key}: ${issue.detail}`).join("\n")}`,
    );
  }
  for (const [key, sourceText] of Object.entries(generated.sourceMessages)) {
    const translated = generated.messages[key] ?? "";
    for (const literal of area.protectedLiterals) {
      if (sourceText.includes(literal) && !translated.includes(literal)) {
        throw new Error(
          `${generated.locale}/${key} changed protected literal ${JSON.stringify(literal)}`,
        );
      }
    }
  }
}

function validateSourceContent(area: CatalogArea, source: SourceCatalog): void {
  const issues = validateCatalog({
    namespace: area.namespace,
    source: source.messages satisfies LocalizationCatalog,
    candidate: source.messages satisfies LocalizationCatalog,
  });
  if (issues.length > 0) {
    throw new Error(
      `${area.id} English source failed catalog validation:\n${issues
        .map((issue) => `- ${issue.code} ${issue.key}: ${issue.detail}`)
        .join("\n")}`,
    );
  }
}

function validateGenerated(
  area: CatalogArea,
  source: SourceCatalog,
  generated: GeneratedCatalog,
): void {
  validateGeneratedContent(area, generated);
  const expectedRevision = catalogSourceRevision(source.messages);
  if (generated.sourceRevision !== expectedRevision) {
    throw new CatalogSourceDriftError(
      `${generated.locale}/${area.id} is stale: expected ${expectedRevision}, received ${generated.sourceRevision}`,
    );
  }
}

function selectAreas(
  registry: CatalogRegistry,
  areaId?: string,
  areaIds?: readonly string[],
): readonly CatalogArea[] {
  if (areaId && areaIds) {
    throw new Error("catalog selection accepts either area or areas, not both");
  }
  if (!areaId && !areaIds) {
    return registry.areas;
  }
  const selectedIds = areaIds ?? [areaId as string];
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("catalog selection contains duplicate area ids");
  }
  const areasById = new Map(registry.areas.map((entry) => [entry.id, entry]));
  return selectedIds.map((selectedId) => {
    const area = areasById.get(selectedId);
    if (!area) {
      throw new Error(`unknown localization catalog area: ${selectedId}`);
    }
    return area;
  });
}

/**
 * Selects only catalog areas whose registry contract or English source changed
 * between two exact repository revisions. Area removal is intentionally not
 * automated because deleting published locale artifacts needs an owner-reviewed
 * migration rather than a generated refresh.
 */
export async function detectChangedCatalogAreas(options: {
  root: string;
  baseRoot: string;
  registryPath?: string;
}): Promise<readonly string[]> {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const current = await readRegistry(options.root, registryPath);
  let base: CatalogRegistry;
  try {
    base = await readRegistry(options.baseRoot, registryPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return Object.freeze(current.areas.map((area) => area.id).toSorted());
    }
    throw error;
  }

  const currentById = new Map(current.areas.map((area) => [area.id, area]));
  const removed = base.areas
    .map((area) => area.id)
    .filter((areaId) => !currentById.has(areaId))
    .toSorted();
  if (removed.length > 0) {
    throw new Error(
      `catalog area removal requires an owner-reviewed migration: ${removed.join(", ")}`,
    );
  }

  const baseById = new Map(base.areas.map((area) => [area.id, area]));
  const changed: string[] = [];
  for (const area of current.areas) {
    const baseArea = baseById.get(area.id);
    if (!baseArea || JSON.stringify(baseArea) !== JSON.stringify(area)) {
      changed.push(area.id);
      continue;
    }
    const [source, baseSource] = await Promise.all([
      readSource(options.root, area),
      readSource(options.baseRoot, baseArea),
    ]);
    if (catalogSourceRevision(source.messages) !== catalogSourceRevision(baseSource.messages)) {
      changed.push(area.id);
    }
  }
  return Object.freeze(changed.toSorted());
}

export async function checkCatalogs(
  options: {
    root?: string;
    registryPath?: string;
    area?: string;
  } = {},
): Promise<void> {
  const root = options.root ?? process.cwd();
  const registry = await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
  for (const area of selectAreas(registry, options.area)) {
    const source = await readSource(root, area);
    validateSourceContent(area, source);
    for (const target of area.targets) {
      validateGenerated(area, source, await readGenerated(root, area, target));
    }
  }
}

export async function detectCatalogDrift(
  options: {
    root?: string;
    registryPath?: string;
    area?: string;
  } = {},
): Promise<readonly string[]> {
  const root = options.root ?? process.cwd();
  const registry = await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const drift: string[] = [];
  for (const area of selectAreas(registry, options.area)) {
    const source = await readSource(root, area);
    validateSourceContent(area, source);
    for (const target of area.targets) {
      try {
        const generated = await readGenerated(root, area, target);
        validateGenerated(area, source, generated);
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
          drift.push(`${target.locale}/${area.id} is missing generated target ${target.path}`);
        } else if (error instanceof CatalogSourceDriftError) {
          drift.push(error.message);
        } else {
          throw error;
        }
      }
    }
  }
  return Object.freeze(drift);
}

function resolveGenerationIdentity(sourceCommit: string) {
  const provider =
    process.env.OPENCLAW_CONTROL_UI_I18N_PROVIDER?.trim() ||
    (process.env.OPENAI_API_KEY?.trim() ? "openai" : "anthropic");
  const model =
    process.env.OPENCLAW_CONTROL_UI_I18N_MODEL?.trim() ||
    (provider === "openai"
      ? process.env.OPENAI_MODEL?.trim()
      : process.env.ANTHROPIC_MODEL?.trim());
  return {
    workflow: process.env.GITHUB_WORKFLOW?.trim() || "localization-catalog-refresh",
    provider,
    model: model || "repository-default",
    sourceCommit,
    glossaryRevision: "none",
    validation: "passed" as const,
  };
}

export async function refreshCatalogs(options: {
  root?: string;
  registryPath?: string;
  area?: string;
  areas?: readonly string[];
  locale?: string;
  sourceCommit: string;
  translator?: CatalogTranslator;
  limits?: Partial<CatalogRefreshLimits>;
  write: boolean;
}): Promise<number> {
  if (!/^[0-9a-f]{40}$/u.test(options.sourceCommit)) {
    throw new Error("catalog refresh requires an exact 40-character source commit");
  }
  const root = options.root ?? process.cwd();
  const registry = await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const translator =
    options.translator ??
    (async (entries, locale) => {
      const { translateCatalogEntries } = await import("./control-ui-i18n.js");
      return await translateCatalogEntries(entries, locale);
    });
  const limits = { ...DEFAULT_REFRESH_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`catalog refresh limit ${name} must be a positive safe integer`);
    }
  }
  const selectedAreas = selectAreas(registry, options.area, options.areas);
  const plan: {
    area: CatalogArea;
    source: SourceCatalog;
    sourceRevision: string;
    targets: readonly CatalogTarget[];
  }[] = [];
  let targetCount = 0;
  let translationCharacters = 0;
  for (const area of selectedAreas) {
    const source = await readSource(root, area);
    validateSourceContent(area, source);
    const sourceEntries = Object.entries(source.messages);
    if (sourceEntries.length > limits.maxMessagesPerArea) {
      throw new Error(
        `catalog area ${area.id} contains ${sourceEntries.length} messages; limit is ${limits.maxMessagesPerArea}`,
      );
    }
    let sourceCharacters = 0;
    for (const [messageId, message] of sourceEntries) {
      if (message.length > limits.maxCharactersPerMessage) {
        throw new Error(
          `catalog message ${messageId} contains ${message.length} characters; limit is ${limits.maxCharactersPerMessage}`,
        );
      }
      sourceCharacters += message.length;
    }
    if (sourceCharacters > limits.maxSourceCharactersPerArea) {
      throw new Error(
        `catalog area ${area.id} contains ${sourceCharacters} source characters; limit is ${limits.maxSourceCharactersPerArea}`,
      );
    }
    const sourceRevision = catalogSourceRevision(source.messages);
    const targets = options.locale
      ? area.targets.filter((target) => target.locale === options.locale)
      : area.targets;
    if (options.locale && targets.length === 0) {
      throw new Error(`area ${area.id} does not declare locale ${options.locale}`);
    }
    const staleTargets: CatalogTarget[] = [];
    for (const target of targets) {
      try {
        const current = await readGenerated(root, area, target);
        validateGenerated(area, source, current);
        continue;
      } catch {
        // Stale or invalid output is regenerated from the complete English family.
      }
      staleTargets.push(target);
    }
    targetCount += staleTargets.length;
    translationCharacters += sourceCharacters * staleTargets.length;
    if (staleTargets.length > 0) {
      plan.push({ area, source, sourceRevision, targets: staleTargets });
    }
  }
  if (plan.length > limits.maxAreas) {
    throw new Error(`catalog refresh selects ${plan.length} areas; limit is ${limits.maxAreas}`);
  }
  if (targetCount > limits.maxTargets) {
    throw new Error(
      `catalog refresh selects ${targetCount} targets; limit is ${limits.maxTargets}`,
    );
  }
  if (translationCharacters > limits.maxTranslationCharacters) {
    throw new Error(
      `catalog refresh selects ${translationCharacters} source-character translations; limit is ${limits.maxTranslationCharacters}`,
    );
  }

  const outputs: { path: string; generated: GeneratedCatalog }[] = [];
  for (const { area, source, sourceRevision, targets } of plan) {
    for (const target of targets) {
      const translated = await translator(
        Object.entries(source.messages).map(([id, text]) => ({
          id,
          source: text,
          sourcePath: area.source,
        })),
        target.locale,
      );
      const generated: GeneratedCatalog = {
        schemaVersion: 1,
        area: area.id,
        locale: target.locale,
        sourceRevision,
        sourceMessages: { ...source.messages },
        generation: resolveGenerationIdentity(options.sourceCommit),
        messages: Object.fromEntries(
          Object.keys(source.messages).map((key) => [
            key,
            expectString(translated.get(key), `${target.locale}.${key}`),
          ]),
        ),
      };
      validateGenerated(area, source, generated);
      outputs.push({ path: target.path, generated });
    }
  }
  if (options.write) {
    for (const output of outputs) {
      const targetPath = await resolveRepositoryFile(root, output.path, { allowMissing: true });
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, `${JSON.stringify(output.generated, null, 2)}\n`, "utf8");
    }
  }
  return outputs.length;
}

type CliArgs = {
  command: "areas" | "changed-areas" | "check" | "detect" | "paths" | "refresh";
  pathKind?: "sources" | "targets";
  area?: string;
  areasFile?: string;
  baseRoot?: string;
  locale?: string;
  root?: string;
  failOnDrift: boolean;
  write: boolean;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const command = argv[0];
  if (
    command !== "areas" &&
    command !== "changed-areas" &&
    command !== "check" &&
    command !== "detect" &&
    command !== "paths" &&
    command !== "refresh"
  ) {
    throw new Error(
      "usage: localization-catalogs.ts areas [--root <path>] | changed-areas --root <path> --base-root <path> | check|detect [--area <id>] [--root <path>] [--fail-on-drift] | paths sources|targets [--area <id>|--areas-file <path>] [--root <path>] | refresh [--area <id>|--areas-file <path>] [--locale <id>] [--root <path>] --write",
    );
  }
  const args: CliArgs = { command, failOnDrift: false, write: false };
  let startIndex = 1;
  if (command === "paths") {
    const pathKind = argv[1];
    if (pathKind !== "sources" && pathKind !== "targets") {
      throw new Error("paths requires sources or targets");
    }
    args.pathKind = pathKind;
    startIndex = 2;
  }
  for (let index = startIndex; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--write") {
      args.write = true;
    } else if (token === "--fail-on-drift") {
      args.failOnDrift = true;
    } else if (
      token === "--area" ||
      token === "--areas-file" ||
      token === "--base-root" ||
      token === "--locale" ||
      token === "--root"
    ) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${token} requires a value`);
      }
      if (token === "--area") {
        args.area = value;
      } else if (token === "--areas-file") {
        args.areasFile = value;
      } else if (token === "--base-root") {
        args.baseRoot = value;
      } else if (token === "--locale") {
        args.locale = value;
      } else {
        args.root = value;
      }
      index += 1;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (args.area && args.areasFile) {
    throw new Error("use either --area or --areas-file, not both");
  }
  if (command === "paths" && (args.locale || args.baseRoot || args.failOnDrift || args.write)) {
    throw new Error("paths accepts only --area, --areas-file, and --root");
  }
  if (
    (command === "check" || command === "detect") &&
    (args.areasFile || args.baseRoot || args.locale || args.write)
  ) {
    throw new Error(`${command} accepts only --area, --root, and detect's --fail-on-drift`);
  }
  if (command === "changed-areas") {
    if (
      !args.root ||
      !args.baseRoot ||
      args.area ||
      args.areasFile ||
      args.locale ||
      args.failOnDrift ||
      args.write
    ) {
      throw new Error("changed-areas requires only --root and --base-root");
    }
  } else if (args.baseRoot) {
    throw new Error("--base-root requires changed-areas");
  }
  if (
    command === "areas" &&
    (args.area || args.areasFile || args.locale || args.failOnDrift || args.write)
  ) {
    throw new Error("areas accepts only --root");
  }
  if (command !== "detect" && args.failOnDrift) {
    throw new Error("--fail-on-drift requires detect");
  }
  return args;
}

async function readAreaIds(filePath: string | undefined): Promise<readonly string[] | undefined> {
  if (!filePath) {
    return undefined;
  }
  const areaIds = (await readFile(filePath, "utf8"))
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (areaIds.length === 0) {
    throw new Error("--areas-file must contain at least one catalog area id");
  }
  return areaIds;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const areas = await readAreaIds(args.areasFile);
  if (args.command === "changed-areas") {
    const changed = await detectChangedCatalogAreas({
      root: args.root as string,
      baseRoot: args.baseRoot as string,
    });
    process.stdout.write(`${changed.join("\n")}${changed.length > 0 ? "\n" : ""}`);
    return;
  }
  if (args.command === "areas") {
    const areaIds = await catalogWorkflowAreas({ root: args.root });
    process.stdout.write(`${areaIds.join("\n")}\n`);
    return;
  }
  if (args.command === "check") {
    await checkCatalogs({ area: args.area, root: args.root });
    process.stdout.write("localization catalogs are current\n");
    return;
  }
  if (args.command === "detect") {
    const drift = await detectCatalogDrift({ area: args.area, root: args.root });
    for (const finding of drift) {
      process.stdout.write(`::${args.failOnDrift ? "error" : "warning"}::${finding}\n`);
    }
    process.stdout.write(`detected ${drift.length} stale localization catalog(s)\n`);
    if (args.failOnDrift && drift.length > 0) {
      throw new Error(
        "ready same-repository PRs must run Localization Catalog Refresh before merge",
      );
    }
    return;
  }
  if (args.command === "paths") {
    const paths = await catalogWorkflowPaths({ area: args.area, areas, root: args.root });
    process.stdout.write(`${paths[args.pathKind ?? "sources"].join("\n")}\n`);
    return;
  }
  if (!args.write) {
    throw new Error("refresh requires --write so generated output is reviewable");
  }
  const sourceCommit = process.env.GITHUB_SHA?.trim();
  if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("refresh requires an exact GITHUB_SHA source revision");
  }
  const changed = await refreshCatalogs({
    area: args.area,
    areas,
    locale: args.locale,
    root: args.root,
    sourceCommit,
    write: true,
  });
  process.stdout.write(`refreshed ${changed} localization catalog(s)\n`);
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
