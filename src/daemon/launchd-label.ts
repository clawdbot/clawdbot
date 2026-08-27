/** Resolves the one effective launchd label shared by lifecycle and diagnostics. */
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveGatewayLaunchAgentLabel } from "./constants.js";

export function assertValidLaunchAgentLabel(label: string): string {
  const trimmed = label.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid launchd label: ${sanitizeForLog(trimmed)}`);
  }
  return trimmed;
}

export function resolveLaunchAgentLabel(env?: Record<string, string | undefined>): string {
  const override = env?.OPENCLAW_LAUNCHD_LABEL?.trim();
  return assertValidLaunchAgentLabel(
    override || resolveGatewayLaunchAgentLabel(env?.OPENCLAW_PROFILE),
  );
}
