import {
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogProvider,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_LOCAL_SESSION_HOST_ID } from "./session-catalog-parsing.js";

export type CodexSupervisionMarker = { sourceThreadId: string; sourceHomeId?: string };

export function readCodexSupervisionMarker(entry: {
  pluginExtensions?: Record<string, unknown>;
}): CodexSupervisionMarker | undefined {
  const codex = isRecord(entry.pluginExtensions?.codex) ? entry.pluginExtensions.codex : undefined;
  const marker = codex && isRecord(codex.supervision) ? codex.supervision : undefined;
  const sourceThreadId = marker?.sourceThreadId;
  const sourceHomeId = marker?.sourceHomeId;
  if (
    typeof sourceThreadId !== "string" ||
    !sourceThreadId.trim() ||
    (sourceHomeId !== undefined && (typeof sourceHomeId !== "string" || !sourceHomeId.trim()))
  ) {
    return undefined;
  }
  return {
    sourceThreadId: sourceThreadId.trim(),
    ...(typeof sourceHomeId === "string" ? { sourceHomeId: sourceHomeId.trim() } : {}),
  };
}

export const codexOwnerLocalAudience = {
  kind: "gateway-owner-local",
  prepareVisibility: ({ host, sessionEntries }) => {
    const entries = sessionEntries.entriesForCatalog?.();
    if (!entries) {
      return () => false;
    }
    const adoptedSources = new Set<string>();
    for (const { entry } of entries) {
      const marker = readCodexSupervisionMarker(entry);
      if (marker) {
        // The marker is published with the initial entry, before binding/fork completion.
        // Any current adoption claim denies native visibility, even while initialization is pending.
        adoptedSources.add(
          sessionCatalogAdoptedSourceKey(
            marker.sourceHomeId ?? CODEX_LOCAL_SESSION_HOST_ID,
            marker.sourceThreadId,
          ),
        );
      }
    }
    return (session) =>
      !adoptedSources.has(
        sessionCatalogAdoptedSourceKey(session.sourceHomeId ?? host.hostId, session.threadId),
      ) &&
      !(
        host.hostId === CODEX_LOCAL_SESSION_HOST_ID &&
        adoptedSources.has(
          sessionCatalogAdoptedSourceKey(CODEX_LOCAL_SESSION_HOST_ID, session.threadId),
        )
      );
  },
} satisfies Exclude<NonNullable<SessionCatalogProvider["audience"]>, string>;
