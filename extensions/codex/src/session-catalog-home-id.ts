import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function canonicalCodexCatalogHome(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** One canonical identity for catalog discovery and durable ownership rows. */
export function codexCatalogHomeId(codexHome: string): string {
  return createHash("sha256")
    .update("openclaw:codex-session-catalog-home:v1\0")
    .update(canonicalCodexCatalogHome(codexHome))
    .digest("hex");
}
