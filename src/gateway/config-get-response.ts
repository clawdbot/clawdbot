import { redactConfigSnapshot } from "../config/redact-snapshot.js";
import { getRuntimeConfigAppliedHash, hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";

export function createConfigGetResponse(
  snapshot: ConfigFileSnapshot,
  uiHints: Parameters<typeof redactConfigSnapshot>[1],
) {
  return {
    ...redactConfigSnapshot(snapshot, uiHints),
    configRevisionHash: hashRuntimeConfigValue(snapshot.sourceConfig),
    appliedConfigHash: getRuntimeConfigAppliedHash(),
  };
}
