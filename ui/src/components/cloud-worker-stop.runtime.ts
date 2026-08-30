import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationPlacementStartup } from "../app/session-placement-startup.ts";
import { t } from "../i18n/index.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";

// Lazy action owners load these helpers before confirmation. Pause stays synchronous
// without pulling the recovery schema validators into the initial page bundle.
const recoveryAccess = { readSessionPlacementRecovery, pauseSessionPlacementRecovery };

export async function requestCloudWorkerStop(
  client: Pick<GatewayBrowserClient, "request">,
  session: { key: string; agentId?: string },
  startup: Pick<ApplicationPlacementStartup, "pause">,
): Promise<void> {
  startup.pause(session.key, t("sessionsView.initialTurnPausedByWorkerStop"), recoveryAccess);
  await client.request(
    "sessions.reclaim",
    { key: session.key, ...(session.agentId ? { agentId: session.agentId } : {}) },
    { timeoutMs: 10 * 60_000 },
  );
}
