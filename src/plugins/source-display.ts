import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { shortenHomeInString } from "../utils.js";
import type { PluginRecord } from "./registry.js";
import type { PluginSourceRoots } from "./roots.js";
export { resolvePluginSourceRoots } from "./roots.js";
export type { PluginSourceRoots } from "./roots.js";

function tryRelative(root: string, filePath: string): string | null {
  if (!isPathInside(root, filePath)) {
    return null;
  }
  const rel = path.relative(root, filePath);
  if (!rel || rel === ".") {
    return null;
  }
  // Normalize to forward slashes for display (path.relative uses backslashes on Windows)
  return rel.replaceAll("\\", "/");
}

export function formatPluginSourceForTable(
  plugin: Pick<PluginRecord, "source" | "origin">,
  roots: PluginSourceRoots,
): { value: string; rootKey?: keyof PluginSourceRoots } {
  const raw = plugin.source;

  if (plugin.origin === "bundled" && roots.stock) {
    const rel = tryRelative(roots.stock, raw);
    if (rel) {
      return { value: `stock:${rel}`, rootKey: "stock" };
    }
  }
  if (plugin.origin === "workspace" && roots.workspace) {
    const rel = tryRelative(roots.workspace, raw);
    if (rel) {
      return { value: `workspace:${rel}`, rootKey: "workspace" };
    }
  }
  if (plugin.origin === "global" && roots.global) {
    const rel = tryRelative(roots.global, raw);
    if (rel) {
      return { value: `global:${rel}`, rootKey: "global" };
    }
  }

  // Keep this stable/pasteable; only ~-shorten.
  return { value: shortenHomeInString(raw) };
}
