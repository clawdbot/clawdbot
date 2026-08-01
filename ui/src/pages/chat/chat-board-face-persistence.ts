import type { ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

/**
 * Persists a thread's preferred face so generic navigation opens the same face on
 * any device. Catalog threads are synthetic and have no gateway row to patch, so
 * they keep using their query identity and are skipped. Failures stay silent: the
 * face is already applied locally and a lost preference is not worth a toast.
 */
export function persistSessionBoardFace(
  context: Pick<ApplicationContext, "sessions">,
  sessionKey: string,
  face: BoardFace,
): void {
  if (parseCatalogSessionKey(sessionKey)) {
    return;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  void context.sessions
    .patch(sessionKey, { boardFace: face }, agentId ? { agentId } : {})
    .catch(() => undefined);
}
