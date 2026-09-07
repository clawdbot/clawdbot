import { stableStringify } from "@openclaw/normalization-core";
import type { SessionToolOverrides } from "../config/sessions.js";

export function normalizeSessionToolOverrides(
  raw: SessionToolOverrides | null | undefined,
): SessionToolOverrides | undefined {
  if (!raw) {
    return undefined;
  }
  const normalizeBooleanMap = (value: Record<string, boolean> | undefined) => {
    const entries = Object.entries(value ?? {}).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };
  const mcpToolsDeny = Object.fromEntries(
    Object.entries(raw.mcpToolsDeny ?? {})
      .map(
        ([serverName, toolNames]) =>
          [
            serverName,
            [...new Set(toolNames)].toSorted((left, right) => left.localeCompare(right)),
          ] as const,
      )
      .filter(([, toolNames]) => toolNames.length > 0)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const mcpServers = normalizeBooleanMap(raw.mcpServers);
  const skills = normalizeBooleanMap(raw.skills);
  const normalized: SessionToolOverrides = {
    ...(mcpServers ? { mcpServers } : {}),
    ...(Object.keys(mcpToolsDeny).length > 0 ? { mcpToolsDeny } : {}),
    ...(skills ? { skills } : {}),
    ...(raw.webSearch === false ? { webSearch: false } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Compare sparse tool policy overlays by their canonical stored meaning. */
export function sessionToolOverridesEqual(
  left: SessionToolOverrides | null | undefined,
  right: SessionToolOverrides | null | undefined,
): boolean {
  return (
    stableStringify(normalizeSessionToolOverrides(left)) ===
    stableStringify(normalizeSessionToolOverrides(right))
  );
}
