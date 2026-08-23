/**
 * Builds sandbox/full-access status metadata for embedded-agent run results.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../bash-tools.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import type { resolveSandboxContext } from "../sandbox.js";
import type { EmbeddedFullAccessBlockedReason, EmbeddedSandboxInfo } from "./types.js";

/**
 * Resolves the sandbox/elevated-exec facts exposed to embedded agent results.
 *
 * This keeps host policy, per-agent exec defaults, and sandbox runtime state in one place so
 * channel/status consumers do not infer full-access availability from partial config fields.
 */
type EmbeddedFullAccessExecPolicy = Pick<ExecToolDefaults, "mode" | "security" | "ask">;
type EmbeddedFullAccessHostPolicy = Pick<ExecToolDefaults, "security" | "ask">;
type EmbeddedSandboxInfoExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "security" | "ask" | "node"
>;

function execPolicyBlocksFullAccess(params: {
  execPolicy?: EmbeddedFullAccessExecPolicy;
  hostPolicy?: EmbeddedFullAccessHostPolicy;
}): boolean {
  return (
    (params.execPolicy?.mode !== undefined && params.execPolicy.mode !== "full") ||
    (params.execPolicy?.security !== undefined && params.execPolicy.security !== "full") ||
    (params.execPolicy?.ask !== undefined && params.execPolicy.ask === "always") ||
    (params.hostPolicy?.security !== undefined && params.hostPolicy.security !== "full") ||
    (params.hostPolicy?.ask !== undefined && params.hostPolicy.ask === "always")
  );
}

/** Computes whether elevated exec can provide full host access for an embedded turn. */
export function resolveEmbeddedFullAccessState(params: {
  execElevated?: ExecElevatedDefaults;
  execPolicy?: EmbeddedFullAccessExecPolicy;
  hostPolicy?: EmbeddedFullAccessHostPolicy;
}): {
  available: boolean;
  blockedReason?: EmbeddedFullAccessBlockedReason;
} {
  if (execPolicyBlocksFullAccess(params)) {
    // Explicit exec/host policy wins over elevated availability. A configured elevated backend
    // must not bypass ask/security restrictions chosen for this agent or session.
    return {
      available: false,
      blockedReason: "host-policy",
    };
  }
  if (params.execElevated?.fullAccessAvailable === true) {
    return { available: true };
  }
  if (params.execElevated?.fullAccessAvailable === false) {
    return {
      available: false,
      blockedReason: params.execElevated.fullAccessBlockedReason ?? "host-policy",
    };
  }
  if (!params.execElevated?.enabled || !params.execElevated.allowed) {
    return {
      available: false,
      blockedReason: "host-policy",
    };
  }
  return { available: true };
}

/** Resolves the effective exec policy for sandbox-info reporting. */
export function resolveEmbeddedSandboxInfoExecPolicy(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sandboxAvailable?: boolean;
  execOverrides?: EmbeddedSandboxInfoExecOverrides;
}): EmbeddedFullAccessExecPolicy {
  const defaults = resolveExecDefaults({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sandboxAvailable: params.sandboxAvailable,
    elevatedRequested: true,
    execOverrides: params.execOverrides,
  });
  return {
    mode: defaults.mode,
    security: defaults.security,
    ask: defaults.ask,
  };
}

/** Builds the serializable sandbox metadata attached to embedded agent run results. */
export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
  execElevated?: ExecElevatedDefaults,
  execPolicy?: EmbeddedFullAccessExecPolicy,
  hostPolicy?: EmbeddedFullAccessHostPolicy,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) {
    return undefined;
  }
  const elevatedConfigured = execElevated?.enabled === true;
  const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
  const fullAccess = resolveEmbeddedFullAccessState({
    execElevated,
    execPolicy,
    hostPolicy,
  });
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    containerWorkspaceDir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserBridgeUrl: sandbox.browser?.bridgeUrl,
    hostBrowserAllowed: sandbox.browserAllowHostControl,
    ...(elevatedConfigured
      ? {
          elevated: {
            allowed: elevatedAllowed,
            defaultLevel: execElevated?.defaultLevel ?? "off",
            fullAccessAvailable: fullAccess.available,
            ...(fullAccess.blockedReason
              ? { fullAccessBlockedReason: fullAccess.blockedReason }
              : {}),
          },
        }
      : {}),
  };
}
