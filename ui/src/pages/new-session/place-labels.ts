import { prettifyPlatform } from "../../lib/platform-label.ts";
import type { DraftNode } from "./discovery.ts";

export function isPhoneFamily(deviceFamily: string | undefined): boolean {
  const family = deviceFamily?.toLowerCase() ?? "";
  return ["iphone", "ipad", "ios", "android", "phone"].some((token) => family.includes(token));
}

export function disambiguate<T>(
  items: readonly T[],
  label: (item: T) => string,
  candidates: ReadonlyArray<(item: T) => string | undefined>,
): Array<string | undefined> {
  const groups = new Map<string, number[]>();
  for (const [index, item] of items.entries()) {
    const key = label(item);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }

  const suffixes: Array<string | undefined> = items.map(() => undefined);
  for (const indices of groups.values()) {
    if (indices.length < 2) {
      continue;
    }
    const fallback = candidates.at(-1);
    if (!fallback) {
      continue;
    }
    const candidate =
      candidates.find((option) => {
        const values = indices.map((index) => option(items[index]!) ?? fallback(items[index]!));
        return (
          values.every((value) => value !== undefined) && new Set(values).size === indices.length
        );
      }) ?? fallback;
    for (const index of indices) {
      suffixes[index] = candidate(items[index]!) ?? fallback(items[index]!);
    }
  }
  return suffixes;
}

export function nodeTooltip(node: DraftNode): string | undefined {
  const facts = [
    node.platform ? prettifyPlatform(node.platform) : undefined,
    node.modelIdentifier,
    node.remoteIp,
  ].filter((fact): fact is string => fact !== undefined);
  return facts.length > 0 ? facts.join(" · ") : undefined;
}
