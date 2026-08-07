import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { GatewayStartupProgressExpectation } from "../../infra/gateway-startup-progress.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  renderGatewayPortHealthDiagnostics,
  waitForGatewayHealthyListener,
} from "./restart-health.js";

export async function checkUnmanagedGatewayRestartHealth(params: {
  port: number;
  attempts: number;
  delayMs: number;
  timeoutSeconds: number;
  previousLockIdentity?: GatewayLockIdentity;
  waitIndefinitelyForPreviousOwner: boolean;
  startupProgress?: GatewayStartupProgressExpectation;
  json: boolean;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
}): Promise<void> {
  const health = await waitForGatewayHealthyListener({
    port: params.port,
    attempts: params.attempts,
    delayMs: params.delayMs,
    ...(params.previousLockIdentity
      ? {
          previousLockIdentity: params.previousLockIdentity,
          waitIndefinitelyForPreviousOwner: params.waitIndefinitelyForPreviousOwner,
        }
      : {}),
    ...(params.startupProgress ? { startupProgress: params.startupProgress } : {}),
  });
  if (health.healthy) {
    return;
  }

  if (health.waitOutcome === "still-starting") {
    const message = `Gateway restart was accepted and is still starting after ${params.timeoutSeconds}s. Check progress with openclaw gateway status --deep.`;
    if (params.json) {
      params.warnings.push(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
    return;
  }

  const diagnostics = renderGatewayPortHealthDiagnostics(health);
  const timeoutLine = `Timed out after ${params.timeoutSeconds}s waiting for gateway port ${params.port} to become healthy.`;
  if (params.json) {
    params.warnings.push(timeoutLine, ...diagnostics);
  } else {
    defaultRuntime.log(theme.warn(timeoutLine));
    for (const line of diagnostics) {
      defaultRuntime.log(theme.muted(line));
    }
  }

  params.fail(
    `Gateway restart timed out after ${params.timeoutSeconds}s waiting for health checks.`,
    [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")],
  );
}
