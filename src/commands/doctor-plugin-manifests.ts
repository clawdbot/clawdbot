import fs from "node:fs";
import { z } from "zod";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const LEGACY_MANIFEST_CONTRACT_KEYS = [
  "speechProviders",
  "mediaUnderstandingProviders",
  "imageGenerationProviders",
] as const;

type LegacyManifestContractMigration = {
  manifestPath: string;
  pluginId: string;
  nextRaw: Record<string, unknown>;
  changeLines: string[];
};

const JsonRecordSchema = z.record(z.string(), z.unknown());

function readManifestJson(manifestPath: string): Record<string, unknown> | null {
  try {
    return safeParseJsonWithSchema(JsonRecordSchema, fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

function buildLegacyManifestContractMigration(params: {
  manifestPath: string;
  raw: Record<string, unknown>;
}): LegacyManifestContractMigration | null {
  const nextRaw = { ...params.raw };
  const parsedContracts = safeParseWithSchema(JsonRecordSchema, params.raw.contracts);
  const nextContracts = parsedContracts ? { ...parsedContracts } : {};
  const changeLines: string[] = [];

  for (const key of LEGACY_MANIFEST_CONTRACT_KEYS) {
    if (!(key in params.raw)) {
      continue;
    }
    const legacyValues = normalizeTrimmedStringList(params.raw[key]);
    const contractValues = normalizeTrimmedStringList(nextContracts[key]);
    if (legacyValues.length > 0 && contractValues.length === 0) {
      nextContracts[key] = legacyValues;
      changeLines.push(
        `- ${shortenHomePath(params.manifestPath)}: moved ${key} to contracts.${key}`,
      );
    } else {
      changeLines.push(
        `- ${shortenHomePath(params.manifestPath)}: removed legacy ${key} (kept contracts.${key})`,
      );
    }
    delete nextRaw[key];
  }

  if (changeLines.length === 0) {
    return null;
  }

  if (Object.keys(nextContracts).length > 0) {
    nextRaw.contracts = nextContracts;
  } else {
    delete nextRaw.contracts;
  }

  const pluginId = normalizeOptionalString(params.raw.id) ?? params.manifestPath;
  return {
    manifestPath: params.manifestPath,
    pluginId,
    nextRaw,
    changeLines,
  };
}

export function collectLegacyPluginManifestContractMigrations(params?: {
  env?: NodeJS.ProcessEnv;
}): LegacyManifestContractMigration[] {
  const seen = new Set<string>();
  const migrations: LegacyManifestContractMigration[] = [];

  for (const plugin of loadPluginManifestRegistry({
    cache: false,
    ...(params?.env ? { env: params.env } : {}),
  }).plugins) {
    if (seen.has(plugin.manifestPath)) {
      continue;
    }
    seen.add(plugin.manifestPath);
    const raw = readManifestJson(plugin.manifestPath);
    if (!raw) {
      continue;
    }
    const migration = buildLegacyManifestContractMigration({
      manifestPath: plugin.manifestPath,
      raw,
    });
    if (migration) {
      migrations.push(migration);
    }
  }

  return migrations.toSorted((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

export async function maybeRepairLegacyPluginManifestContracts(params: {
  env?: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  note?: typeof note;
}): Promise<void> {
  const migrations = collectLegacyPluginManifestContractMigrations(
    params.env ? { env: params.env } : undefined,
  );
  if (migrations.length === 0) {
    return;
  }

  const emitNote = params.note ?? note;
  emitNote(
    [
      "Legacy plugin manifest capability keys detected.",
      ...migrations.flatMap((migration) => migration.changeLines),
    ].join("\n"),
    "Plugin manifests",
  );

  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      message: "Rewrite legacy plugin manifest capability keys into contracts now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    return;
  }

  const applied: string[] = [];
  for (const migration of migrations) {
    try {
      fs.writeFileSync(
        migration.manifestPath,
        `${JSON.stringify(migration.nextRaw, null, 2)}\n`,
        "utf-8",
      );
      applied.push(...migration.changeLines);
    } catch (error) {
      params.runtime.error(
        `Failed to rewrite legacy plugin manifest at ${migration.manifestPath}: ${String(error)}`,
      );
    }
  }

  if (applied.length > 0) {
    emitNote(applied.join("\n"), "Doctor changes");
  }
}
