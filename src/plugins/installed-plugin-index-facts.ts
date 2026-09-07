import { isProxy } from "node:util/types";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexFacts,
} from "./installed-plugin-index-types.js";
import { getPluginCache } from "./plugin-cache.js";

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
