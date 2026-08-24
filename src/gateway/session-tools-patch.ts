import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry, SessionToolOverrides } from "../config/sessions.js";
import { sessionToolModeSelectionError } from "../plugins/session-tool-modes.js";

function normalizeSessionToolOverrides(
  raw: SessionToolOverrides,
): SessionToolOverrides | undefined {
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

export function applySessionToolsPatch(
  entry: SessionEntry,
  patch: SessionsPatchParams,
  runtimeId: string,
): string | undefined {
  if ("toolOverrides" in patch) {
    if (patch.toolOverrides === null) {
      delete entry.toolOverrides;
    } else if (patch.toolOverrides !== undefined) {
      // Session patches replace this sparse overlay atomically; they never deep-merge old policy.
      const normalized = normalizeSessionToolOverrides(patch.toolOverrides);
      if (normalized) {
        entry.toolOverrides = normalized;
      } else {
        delete entry.toolOverrides;
      }
    }
  }
  if (!("toolMode" in patch)) {
    if ("model" in patch && entry.toolMode && runtimeId.trim().toLowerCase() !== "openclaw") {
      delete entry.toolMode;
    }
    return undefined;
  }
  if (patch.toolMode === null) {
    delete entry.toolMode;
    return undefined;
  }
  if (patch.toolMode === undefined) {
    return undefined;
  }
  const selectionError = sessionToolModeSelectionError({
    selection: patch.toolMode,
    runtimeId,
  });
  if (selectionError) {
    return selectionError;
  }
  entry.toolMode = { pluginId: patch.toolMode.pluginId, modeId: patch.toolMode.modeId };
  return undefined;
}
