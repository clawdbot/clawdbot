import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type LocalizationCatalog,
  validateCatalog,
} from "../packages/localization-core/src/catalog.js";

type CatalogTarget = {
  locale: string;
  path: string;
};

type CatalogArea = {
  id: string;
  namespace: string;
  source: string;
  targets: readonly CatalogTarget[];
  protectedLiterals: readonly string[];
};

type CatalogRegistry = {
  schemaVersion: 1;
  areas: readonly CatalogArea[];
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

function expectStringMap(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, expectString(entry, `${label}.${key}`)]),
  );
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readRegistry(root: string, registryPath: string): Promise<CatalogRegistry> {
  const raw = await readJson(path.resolve(root, registryPath));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.areas)) {
    throw new Error("localization catalog registry must use schemaVersion 1 and declare areas");
  }
  const areas = raw.areas.map((entry, index): CatalogArea => {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.targets) ||
      !Array.isArray(entry.protectedLiterals)
    ) {
      throw new Error(`localization catalog registry area ${index} is malformed`);
    }
    return {
      id: expectString(entry.id, `areas[${index}].id`),
      namespace: expectString(entry.namespace, `areas[${index}].namespace`),
      source: expectString(entry.source, `areas[${index}].source`),
      targets: entry.targets.map((target, targetIndex) => {
        if (!isRecord(target)) {
          throw new Error(`areas[${index}].targets[${targetIndex}] is malformed`);
        }
        return {
          locale: expectString(target.locale, `areas[${index}].targets[${targetIndex}].locale`),
          path: expectString(target.path, `areas[${index}].targets[${targetIndex}].path`),
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
  return { schemaVersion: 1, areas };
}

async function readSource(root: string, area: CatalogArea): Promise<SourceCatalog> {
  const raw = await readJson(path.resolve(root, area.source));
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
  const raw = await readJson(path.resolve(root, target.path));
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
      Object.entries(messages).toSorted(([left], [right]) => left.localeCompare(right)),
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

function selectAreas(registry: CatalogRegistry, areaId?: string): readonly CatalogArea[] {
  if (!areaId) {
    return registry.areas;
  }
  const area = registry.areas.find((entry) => entry.id === areaId);
  if (!area) {
    throw new Error(`unknown localization catalog area: ${areaId}`);
  }
  return [area];
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
    for (const target of area.targets) {
      const generated = await readGenerated(root, area, target);
      try {
        validateGenerated(area, source, generated);
      } catch (error) {
        if (!(error instanceof CatalogSourceDriftError)) {
          throw error;
        }
        drift.push(error.message);
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
    provider === "openai" ? process.env.OPENAI_MODEL?.trim() : process.env.ANTHROPIC_MODEL?.trim();
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
  locale?: string;
  sourceCommit: string;
  translator?: CatalogTranslator;
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
  let changed = 0;
  for (const area of selectAreas(registry, options.area)) {
    const source = await readSource(root, area);
    const sourceRevision = catalogSourceRevision(source.messages);
    const targets = options.locale
      ? area.targets.filter((target) => target.locale === options.locale)
      : area.targets;
    if (options.locale && targets.length === 0) {
      throw new Error(`area ${area.id} does not declare locale ${options.locale}`);
    }
    for (const target of targets) {
      try {
        const current = await readGenerated(root, area, target);
        validateGenerated(area, source, current);
        continue;
      } catch {
        // Stale or invalid output is regenerated from the complete English family.
      }
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
      changed += 1;
      if (options.write) {
        await writeFile(
          path.resolve(root, target.path),
          `${JSON.stringify(generated, null, 2)}\n`,
          "utf8",
        );
      }
    }
  }
  return changed;
}

type CliArgs = {
  command: "check" | "detect" | "refresh";
  area?: string;
  locale?: string;
  write: boolean;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const command = argv[0];
  if (command !== "check" && command !== "detect" && command !== "refresh") {
    throw new Error(
      "usage: localization-catalogs.ts check|detect [--area <id>] | refresh [--area <id>] [--locale <id>] --write",
    );
  }
  const args: CliArgs = { command, write: false };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--write") {
      args.write = true;
    } else if (token === "--area" || token === "--locale") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${token} requires a value`);
      }
      if (token === "--area") args.area = value;
      else args.locale = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "check") {
    await checkCatalogs({ area: args.area });
    process.stdout.write("localization catalogs are current\n");
    return;
  }
  if (args.command === "detect") {
    const drift = await detectCatalogDrift({ area: args.area });
    for (const finding of drift) {
      process.stdout.write(`::warning::${finding}\n`);
    }
    process.stdout.write(`detected ${drift.length} stale localization catalog(s)\n`);
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
    locale: args.locale,
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
