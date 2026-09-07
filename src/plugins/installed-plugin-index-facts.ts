import { isProxy } from "node:util/types";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { InstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { getPluginCache } from "./plugin-cache.js";

export type InstalledPluginIndexFacts = {
  fingerprint?: string;
  scopeLookup?: InstalledPluginIndexScopeLookup;
  installRecords?: Record<string, PluginInstallRecord>;
};

function isDeepFrozenJsonLike(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function";
  }
  if (seen.has(value)) {
    return true;
  }
  if (isProxy(value) || !Object.isFrozen(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
    return false;
  }
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (entry) => "value" in entry && isDeepFrozenJsonLike(entry.value, seen),
  );
}

/** Package facts share the existing generation; mutable management inputs stay uncached. */
export function getInstalledPluginIndexFacts(
  index: InstalledPluginIndex,
): InstalledPluginIndexFacts | undefined {
  const entries = getPluginCache().metadata.indexFacts;
  const existing = entries.get(index);
  if (existing) {
    return existing;
  }
  if (!isDeepFrozenJsonLike(index)) {
    return undefined;
  }
  const facts: InstalledPluginIndexFacts = {};
  entries.set(index, facts);
  return facts;
}
