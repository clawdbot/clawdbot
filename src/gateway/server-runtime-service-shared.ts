import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";

// Shared runtime service helpers avoid pulling full startup services into tests
// and minimal gateway paths that only need stable service handles.
export type GatewayRuntimeServiceLogger = {
  child: (name: string) => {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  error: (message: string) => void;
};

/** Creates a heartbeat runner placeholder for minimal/test gateway service state. */
export function createNoopHeartbeatRunner(): HeartbeatRunner {
  return {
    stop: () => {},
    updateConfig: (_cfg: OpenClawConfig) => {},
  };
}
