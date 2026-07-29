// Hashes installed plugin index records for change detection.
import crypto from "node:crypto";
import fs from "node:fs";
import type { PluginDiagnostic } from "./manifest-types.js";

/** File metadata signature used to skip unchanged installed plugin files. */
export type InstalledPluginFileSignature = {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
};

function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Hashes JSON-serializable data with SHA-256. */
export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}

/** Safely hashes a file, optionally recording required-file diagnostics. */
export function safeHashFile(params: {
  filePath: string;
  pluginId?: string;
  diagnostics: PluginDiagnostic[];
  required: boolean;
}): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(params.filePath)).digest("hex");
  } catch (err) {
    if (params.required) {
      params.diagnostics.push({
        level: "warn",
        ...(params.pluginId ? { pluginId: params.pluginId } : {}),
        source: params.filePath,
        message: `installed plugin index could not hash ${params.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    return undefined;
  }
}

/** Reads a safe file signature for installed plugin index freshness checks. */
export function safeFileSignature(filePath: string): InstalledPluginFileSignature | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return undefined;
    }
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch {
    return undefined;
  }
}

/** Compares current file metadata with a stored installed-plugin file signature. */
export function fileSignatureMatches(
  filePath: string,
  signature: InstalledPluginFileSignature | undefined,
): boolean | undefined {
  if (!signature) {
    return undefined;
  }
  if (typeof signature.ctimeMs !== "number") {
    return undefined;
  }
  const current = safeFileSignature(filePath);
  if (!current) {
    return false;
  }
  return (
    current.size === signature.size &&
    current.mtimeMs === signature.mtimeMs &&
    current.ctimeMs === signature.ctimeMs
  );
}
