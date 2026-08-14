import { createConfigRuntimeEnv } from "../../config/env-vars.js";
import { resolveShellEnvExpectedKeys } from "../../config/shell-env-expected-keys.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../../infra/shell-env.js";

export type GatewayShellEnvFallbackPlan =
  | { enabled: false }
  | {
      enabled: true;
      expectedKeys: string[];
      missingKeys: string[];
      timeoutMs: number;
    };

export function resolveGatewayShellEnvFallbackPlan(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): GatewayShellEnvFallbackPlan {
  const planEnv = createConfigRuntimeEnv(cfg, baseEnv);
  const enabled =
    (shouldEnableShellEnvFallback(planEnv) || cfg.env?.shellEnv?.enabled === true) &&
    !shouldDeferShellEnvFallback(planEnv);
  if (!enabled) {
    return { enabled: false };
  }
  const expectedKeys = resolveShellEnvExpectedKeys(planEnv);
  return {
    enabled: true,
    expectedKeys,
    missingKeys: expectedKeys.filter((key) => !Object.hasOwn(planEnv, key)),
    timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(planEnv),
  };
}
