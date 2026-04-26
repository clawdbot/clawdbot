import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAcpEnabledByPolicy } from "../policy.js";
import { getAcpRuntimeBackend } from "./registry.js";

export function isAcpRuntimeSpawnAvailable(params: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  backendId?: string;
}): boolean {
  if (params.sandboxed === true) {
    return false;
  }
  if (params.config && !isAcpEnabledByPolicy(params.config)) {
    return false;
  }
  const backend = getAcpRuntimeBackend(params.backendId ?? params.config?.acp?.backend);
  if (!backend) {
    return false;
  }
  if (!backend.healthy) {
    return true;
  }
  try {
    return backend.healthy();
  } catch {
    return false;
  }
}
