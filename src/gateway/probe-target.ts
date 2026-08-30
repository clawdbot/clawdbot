// Gateway probe target resolver.
// Chooses local or remote probe mode from gateway config and URL availability.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Probe target resolution converts configured gateway mode into the actual
// reachable target. Remote mode falls back to local probing when no remote URL
// exists so startup diagnostics can explain the missing URL.
export type GatewayProbeTargetResolution = {
  gatewayMode: "local" | "remote";
  mode: "local" | "remote";
  remoteUrlMissing: boolean;
};

/** Resolves whether gateway probe commands should target local or remote gateway. */
export function resolveGatewayProbeTarget(cfg: OpenClawConfig): GatewayProbeTargetResolution {
  const gatewayMode = cfg.gateway?.mode === "remote" ? "remote" : "local";
  const remoteUrlRaw = normalizeOptionalString(cfg.gateway?.remote?.url) ?? "";
  const remoteUrlMissing = gatewayMode === "remote" && !remoteUrlRaw;
  return {
    gatewayMode,
    mode: gatewayMode === "remote" && !remoteUrlMissing ? "remote" : "local",
    remoteUrlMissing,
  };
}
