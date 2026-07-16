import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { shortenHomePath } from "../utils.js";
import { isReservedSystemAgentId } from "./agent-id.js";

export function requireValidSystemAgentSetupSnapshot(snapshot: ConfigFileSnapshot): {
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
} {
  if (snapshot.exists && !snapshot.valid) {
    const issue = snapshot.issues?.[0];
    const detail = issue ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "";
    throw new Error(
      `OpenClaw config ${shortenHomePath(snapshot.path)} is invalid${detail}. Fix it before running setup.`,
    );
  }
  const sourceConfig = snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const runtimeConfig = snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const reservedAgent = runtimeConfig.agents?.list?.find((entry) =>
    isReservedSystemAgentId(entry.id),
  );
  if (reservedAgent) {
    throw new Error(
      `Agent id "${normalizeAgentId(reservedAgent.id)}" is reserved for the system agent. Rename that configured agent, then retry setup.`,
    );
  }
  return { sourceConfig, runtimeConfig };
}
