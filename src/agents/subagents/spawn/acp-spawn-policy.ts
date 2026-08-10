import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { resolveSpawnSandboxError } from "../../spawn-plan.js";

export function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: "inherit" | "require";
}): string | undefined {
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  return resolveSpawnSandboxError({ backend: "acp", requesterSandboxed, sandbox: sandboxMode });
}
