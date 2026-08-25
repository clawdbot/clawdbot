import type { SessionsListResult } from "../../api/types.ts";
import type { SessionArchiveVisibility } from "./session-capability.ts";

export function createSessionArchiveVisibility(onChange: () => void) {
  const visibilityByKey = new Map<string, SessionArchiveVisibility>();
  const clear = (key: string) => visibilityByKey.delete(key.trim());
  return {
    clear,
    clearAll: () => visibilityByKey.clear(),
    get: (key: string) => visibilityByKey.get(key.trim()),
    set(key: string, visibility: SessionArchiveVisibility | undefined) {
      const normalizedKey = key.trim();
      if (!normalizedKey || visibilityByKey.get(normalizedKey) === visibility) {
        return;
      }
      if (visibility) {
        visibilityByKey.set(normalizedKey, visibility);
      } else {
        clear(normalizedKey);
      }
      onChange();
    },
    settle(result: SessionsListResult | null) {
      for (const row of result?.sessions ?? []) {
        if (row.archived !== true && visibilityByKey.get(row.key) === "archived") {
          clear(row.key);
        }
      }
    },
  };
}
