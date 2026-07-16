import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { MODEL_SETUP_DETECT_TIMEOUT_MS } from "./state.ts";

export function detectModelSetup(
  client: GatewayBrowserClient,
  signal?: AbortSignal,
): Promise<SystemAgentSetupDetectResult> {
  return client.request<SystemAgentSetupDetectResult>(
    "openclaw.setup.detect",
    {},
    { timeoutMs: MODEL_SETUP_DETECT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
}
