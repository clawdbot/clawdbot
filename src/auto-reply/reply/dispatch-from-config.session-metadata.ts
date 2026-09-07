import type { CommandSessionMetadataChange } from "./command-session-metadata.js";

export function createSessionMetadataChangeNotifier(
  onSessionMetadataChanges: ((changes: CommandSessionMetadataChange[]) => void) | undefined,
) {
  const notifiedKeys = new Set<string>();
  const routeState: { sessionMetadataChangesForResult?: CommandSessionMetadataChange[] } = {};
  const notifySessionMetadataChanges = (
    changes: CommandSessionMetadataChange[] | undefined,
  ): void => {
    if (!changes?.length) {
      return;
    }
    const freshChanges = changes.filter((change) => {
      const key = JSON.stringify([change.sessionKey, change.agentId ?? null, change.reason]);
      if (notifiedKeys.has(key)) {
        return false;
      }
      notifiedKeys.add(key);
      return true;
    });
    if (freshChanges.length === 0) {
      return;
    }
    routeState.sessionMetadataChangesForResult = [
      ...(routeState.sessionMetadataChangesForResult ?? []),
      ...freshChanges,
    ];
    onSessionMetadataChanges?.(freshChanges);
  };
  return { notifySessionMetadataChanges, routeState };
}
