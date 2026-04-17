import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import type { QaProviderMode } from "./model-selection.js";

type QaLiveTimeoutEnv = {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
};

function liveTurnTimeoutMs(env: QaLiveTimeoutEnv, fallbackMs: number) {
  return resolveQaLiveTurnTimeoutMs(env, fallbackMs);
}

export { liveTurnTimeoutMs };
export type { QaLiveTimeoutEnv };
