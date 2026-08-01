import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "../../infra/errors.js";
import type { ExternalizedBundledPluginBridge } from "../../plugins/externalized-bundled-plugins.js";

function normalizeStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  const entries = value.map((entry) => normalizeOptionalString(entry));
  if (entries.some((entry) => !entry)) {
    throw new Error(`${field} must contain non-empty strings`);
  }
  return entries as string[];
}

function normalizeExternalizationBridge(
  value: unknown,
  index: number,
): ExternalizedBundledPluginBridge {
  if (!isRecord(value)) {
    throw new Error(`bridge ${index} must be an object`);
  }
  const bundledPluginId = normalizeOptionalString(value.bundledPluginId);
  if (!bundledPluginId) {
    throw new Error(`bridge ${index} is missing bundledPluginId`);
  }
  const preferredSource = value.preferredSource;
  if (preferredSource !== undefined && preferredSource !== "npm" && preferredSource !== "clawhub") {
    throw new Error(`bridge ${index} has an invalid preferredSource`);
  }
  if (value.enabledByDefault !== undefined && typeof value.enabledByDefault !== "boolean") {
    throw new Error(`bridge ${index} has an invalid enabledByDefault`);
  }
  const optionalStrings = {
    pluginId: normalizeOptionalString(value.pluginId),
    npmSpec: normalizeOptionalString(value.npmSpec),
    clawhubSpec: normalizeOptionalString(value.clawhubSpec),
    clawhubUrl: normalizeOptionalString(value.clawhubUrl),
    bundledDirName: normalizeOptionalString(value.bundledDirName),
  };
  const legacyPluginIds = normalizeStringArray(
    value.legacyPluginIds,
    `bridge ${index}.legacyPluginIds`,
  );
  const channelIds = normalizeStringArray(value.channelIds, `bridge ${index}.channelIds`);
  const preferOver = normalizeStringArray(value.preferOver, `bridge ${index}.preferOver`);
  return {
    bundledPluginId,
    ...(optionalStrings.pluginId ? { pluginId: optionalStrings.pluginId } : {}),
    ...(preferredSource ? { preferredSource } : {}),
    ...(optionalStrings.npmSpec ? { npmSpec: optionalStrings.npmSpec } : {}),
    ...(optionalStrings.clawhubSpec ? { clawhubSpec: optionalStrings.clawhubSpec } : {}),
    ...(optionalStrings.clawhubUrl ? { clawhubUrl: optionalStrings.clawhubUrl } : {}),
    ...(optionalStrings.bundledDirName ? { bundledDirName: optionalStrings.bundledDirName } : {}),
    ...(value.enabledByDefault !== undefined ? { enabledByDefault: value.enabledByDefault } : {}),
    ...(legacyPluginIds ? { legacyPluginIds } : {}),
    ...(channelIds ? { channelIds } : {}),
    ...(preferOver ? { preferOver } : {}),
  };
}

export async function writePostCoreExternalizationBridgesFile(
  filePath: string,
  bridges: readonly ExternalizedBundledPluginBridge[],
): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(bridges)}\n`, "utf-8");
}

export async function readPostCoreExternalizationBridgesFile(
  filePath: string | undefined,
): Promise<readonly ExternalizedBundledPluginBridge[] | undefined> {
  if (!filePath) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return undefined;
    }
    throw new Error(`Unable to read externalization bridges file: ${filePath}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed JSON in externalization bridges file: ${filePath}`, { cause: err });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Externalization bridges file must contain an array: ${filePath}`);
  }
  return parsed.map(normalizeExternalizationBridge);
}
