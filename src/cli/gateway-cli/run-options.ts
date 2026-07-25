// Source-aware gateway run option resolution shared by pre-action and runtime startup.
import type { Command } from "commander";
import { inheritOptionFromParent } from "../command-options.js";

export type GatewayRunOpts = {
  port?: unknown;
  bind?: unknown;
  token?: unknown;
  auth?: unknown;
  password?: unknown;
  passwordFile?: unknown;
  configLayer?: unknown;
  tailscale?: unknown;
  tailscaleResetOnExit?: boolean;
  allowUnconfigured?: boolean;
  force?: boolean;
  verbose?: boolean;
  cliBackendLogs?: boolean;
  /** @deprecated Use cliBackendLogs. */
  claudeCliLogs?: boolean;
  wsLog?: unknown;
  compact?: boolean;
  rawStream?: boolean;
  rawStreamPath?: unknown;
  dev?: boolean;
  devAmbientChannels?: boolean;
  reset?: boolean;
};

const GATEWAY_RUN_VALUE_KEYS = [
  "port",
  "bind",
  "token",
  "auth",
  "password",
  "passwordFile",
  "configLayer",
  "tailscale",
  "wsLog",
  "rawStreamPath",
] as const;

const GATEWAY_RUN_BOOLEAN_KEYS = [
  "tailscaleResetOnExit",
  "allowUnconfigured",
  "dev",
  "devAmbientChannels",
  "reset",
  "force",
  "verbose",
  "cliBackendLogs",
  "claudeCliLogs",
  "compact",
  "rawStream",
] as const;

export function resolveGatewayRunOptions(opts: GatewayRunOpts, command?: Command): GatewayRunOpts {
  const resolved: GatewayRunOpts = { ...opts };

  for (const key of GATEWAY_RUN_VALUE_KEYS) {
    const inherited = inheritOptionFromParent(command, key);
    if (key === "wsLog") {
      // wsLog has a child default ("auto"), so prefer inherited parent CLI value when present.
      resolved[key] = inherited ?? resolved[key];
      continue;
    }
    resolved[key] = resolved[key] ?? inherited;
  }

  for (const key of GATEWAY_RUN_BOOLEAN_KEYS) {
    const inherited = inheritOptionFromParent<boolean>(command, key);
    resolved[key] = Boolean(resolved[key] || inherited);
  }

  return resolved;
}
