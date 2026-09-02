// Heartbeat event and visibility helpers without the broad infra-runtime barrel.
import { requestHeartbeat } from "../infra/heartbeat-wake.js";

type RequestHeartbeatOptions = Parameters<typeof requestHeartbeat>[0];

export function requestPluginHeartbeat(opts: RequestHeartbeatOptions): void {
  requestHeartbeat(opts);
}
