import crypto from "node:crypto";
import fs from "node:fs";
import type { PluginDiagnostic } from "./manifest-types.js";

export function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}

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
