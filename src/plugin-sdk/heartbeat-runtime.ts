// Heartbeat event and visibility helpers without the broad infra-runtime barrel.
import { requestHeartbeatRaw as requestHeartbeatInternal } from "../infra/heartbeat-wake.js";

type RequestHeartbeatOptions = Parameters<typeof requestHeartbeatInternal>[0];

export function requestHeartbeat(opts: RequestHeartbeatOptions): void {
  requestHeartbeatInternal({
    source: opts.source,
    intent: opts.intent,
    reason: opts.reason,
    coalesceMs: opts.coalesceMs,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    parentRunId: opts.parentRunId,
    heartbeat: opts.heartbeat,
  });
}
