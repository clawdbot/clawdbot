import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";

type QaLiveTimeoutEnv = {
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
};

function liveTurnTimeoutMs(env: QaLiveTimeoutEnv, fallbackMs: number) {
  return resolveQaLiveTurnTimeoutMs(env, fallbackMs);
}

export { liveTurnTimeoutMs };
export type { QaLiveTimeoutEnv };
