import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";

export async function clearLegacyEmbeddedAcpMetadata(params: {
  storePath: string;
  sessionKeys: Iterable<string | null | undefined>;
}): Promise<void> {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => sessionKey?.trim()).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  for (const sessionKey of sessionKeys) {
    await patchSessionEntryWithKey(
      { storePath: params.storePath, sessionKey },
      (entry) => {
        if (!entry.acp) {
          return null;
        }
        const next = { ...entry };
        delete next.acp;
        return next;
      },
      { replaceEntry: true, skipMaintenance: true },
    );
  }
}
