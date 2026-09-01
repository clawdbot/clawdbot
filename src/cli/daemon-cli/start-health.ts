import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayService } from "../../daemon/service.js";
import { formatCliCommand } from "../command-format.js";
import {
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  renderRestartDiagnostics,
  waitForGatewayHttpReadiness,
  waitForGatewayHealthyRestart,
} from "./restart-health.js";

export async function verifyGatewayStartReadiness(params: {
  expectedPort?: number;
  fail: (message: string, hints?: string[]) => void;
  resolveContext: () => Promise<{ config?: OpenClawConfig; env: NodeJS.ProcessEnv; port: number }>;
  service: GatewayService;
  warnings: string[];
}): Promise<void> {
  const { deadlineMs } = resolveGatewayStartupTiming();
  const context = await params.resolveContext();
  const port = params.expectedPort ?? context.port;
  const deadlineAt = Date.now() + deadlineMs;
  const attempts = Math.ceil(deadlineMs / DEFAULT_RESTART_HEALTH_DELAY_MS);
  const [health, readiness] = await Promise.all([
    waitForGatewayHealthyRestart({
      service: params.service,
      port,
      attempts,
      delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
      env: context.env,
      includeUnknownListenersAsStale: process.platform === "win32",
      supervisorKeepsAlive: process.platform === "darwin",
    }),
    waitForGatewayHttpReadiness({
      config: context.config,
      port,
      attempts,
      deadlineAt,
      delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
    }),
  ]);
  if (health.healthy && readiness.healthz === 200 && readiness.readyz === 200) {
    return;
  }
  params.warnings.push(...renderRestartDiagnostics(health));
  params.warnings.push(
    `Gateway HTTP readiness: /healthz=${readiness.healthz ?? "unreachable"}; ` +
      `/readyz=${readiness.readyz ?? "unreachable"}.`,
  );
  params.fail(
    `Gateway start timed out after ${Math.round(deadlineMs / 1000)}s waiting for /healthz and /readyz.`,
    [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")],
  );
}
