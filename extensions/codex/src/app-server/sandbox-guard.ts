/**
 * Blocks direct Codex app-server requests that would bypass OpenClaw sandbox or
 * node-exec routing guarantees.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSandboxRuntimeStatus } from "openclaw/plugin-sdk/sandbox";
import {
  formatCodexNativeNodeExecBlock,
  resolveCodexNativeExecutionPolicy,
} from "./native-execution-policy.js";

type DirectMethodPolicy =
  | "allowed-control-plane"
  | "blocked-native-bypass"
  | "requires-openclaw-environment";

const DIRECT_METHOD_POLICIES = new Map<string, DirectMethodPolicy>([
  ["account/rateLimits/read", "allowed-control-plane"],
  ["account/read", "allowed-control-plane"],
  ["app/list", "allowed-control-plane"],
  ["config/mcpServer/reload", "allowed-control-plane"],
  ["environment/add", "allowed-control-plane"],
  ["experimentalFeature/enablement/set", "allowed-control-plane"],
  ["feedback/upload", "allowed-control-plane"],
  ["hooks/list", "allowed-control-plane"],
  ["initialize", "allowed-control-plane"],
  ["marketplace/add", "allowed-control-plane"],
  ["mcpServerStatus/list", "allowed-control-plane"],
  ["model/list", "allowed-control-plane"],
  ["plugin/install", "allowed-control-plane"],
  ["plugin/list", "allowed-control-plane"],
  ["plugin/read", "allowed-control-plane"],
  ["skills/list", "allowed-control-plane"],
  ["thread/archive", "allowed-control-plane"],
  ["thread/inject_items", "allowed-control-plane"],
  ["thread/list", "allowed-control-plane"],
  ["thread/metadata/update", "allowed-control-plane"],
  ["thread/name/update", "allowed-control-plane"],
  ["thread/read", "allowed-control-plane"],
  ["thread/rollback", "allowed-control-plane"],
  ["thread/start", "requires-openclaw-environment"],
  ["thread/unarchive", "allowed-control-plane"],
  ["thread/unsubscribe", "allowed-control-plane"],
  ["turn/interrupt", "allowed-control-plane"],
  ["turn/steer", "allowed-control-plane"],

  ["command/exec", "blocked-native-bypass"],
  ["command/resize", "blocked-native-bypass"],
  ["command/terminate", "blocked-native-bypass"],
  ["command/write", "blocked-native-bypass"],
  ["fuzzyFileSearch", "blocked-native-bypass"],
  ["mcpServer/resource/read", "blocked-native-bypass"],
  ["mcpServer/tool/call", "blocked-native-bypass"],
  ["process/kill", "blocked-native-bypass"],
  ["process/resizePty", "blocked-native-bypass"],
  ["process/spawn", "blocked-native-bypass"],
  ["process/writeStdin", "blocked-native-bypass"],
  ["review/start", "blocked-native-bypass"],
  ["thread/compact/start", "blocked-native-bypass"],
  ["thread/fork", "blocked-native-bypass"],
  ["thread/resume", "blocked-native-bypass"],
  ["thread/shellCommand", "blocked-native-bypass"],
  ["turn/start", "blocked-native-bypass"],
]);

const BLOCKED_DIRECT_METHOD_PREFIXES = ["command/", "fs/", "windowsSandbox/"] as const;
const NODE_EXEC_BLOCKED_CONTROL_PLANE_METHODS = new Set<string>([
  // Reloading MCP servers can start app-backed processes in the Codex app-server environment.
  "config/mcpServer/reload",
]);

/** Returns a block message when a direct app-server method would bypass OpenClaw execution policy. */
export function resolveCodexAppServerDirectSandboxBypassBlock(params: {
  method: string;
  requestParams?: unknown;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  const policy = resolveDirectMethodPolicy(params.method);
  if (NODE_EXEC_BLOCKED_CONTROL_PLANE_METHODS.has(params.method)) {
    const nodeExecBlock = resolveCodexNativeNodeExecBlock({
      config: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      surface: `app-server method \`${params.method}\``,
    });
    if (nodeExecBlock) {
      return nodeExecBlock;
    }
  }
  if (policy === "allowed-control-plane") {
    return undefined;
  }
  const nodeExecBlock = resolveCodexNativeNodeExecBlock({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    surface: `app-server method \`${params.method}\``,
  });
  if (nodeExecBlock) {
    return nodeExecBlock;
  }
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const sandboxBlock = resolveCodexNativeSandboxBlock({
    config: params.config,
    sessionKey,
    surface: `app-server method \`${params.method}\``,
  });
  if (!sandboxBlock) {
    return undefined;
  }
  if (
    policy === "requires-openclaw-environment" &&
    hasOpenClawSandboxEnvironmentSelection(params.requestParams)
  ) {
    return undefined;
  }
  return sandboxBlock;
}

/** Resolves the generic native-execution block for sandboxed or node-hosted sessions. */
export function resolveCodexNativeExecutionBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  surface: string;
}): string | undefined {
  return resolveCodexNativeSandboxBlock(params) ?? resolveCodexNativeNodeExecBlock(params);
}

/** Returns a block message when native Codex execution cannot honor active sandboxing. */
export function resolveCodexNativeSandboxBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  surface: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey,
  });
  if (!runtime.sandboxed) {
    return undefined;
  }
  return formatCodexNativeSandboxBlock({ surface: params.surface });
}

function resolveDirectMethodPolicy(method: string): DirectMethodPolicy {
  const exact = DIRECT_METHOD_POLICIES.get(method);
  if (exact) {
    return exact;
  }
  if (BLOCKED_DIRECT_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return "blocked-native-bypass";
  }
  return "blocked-native-bypass";
}

function hasOpenClawSandboxEnvironmentSelection(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const environments = (value as { environments?: unknown }).environments;
  return (
    Array.isArray(environments) &&
    environments.length > 0 &&
    environments.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const environment = entry as { environmentId?: unknown; cwd?: unknown };
      return (
        typeof environment.environmentId === "string" &&
        environment.environmentId.startsWith("openclaw-sandbox-") &&
        typeof environment.cwd === "string" &&
        environment.cwd.trim().length > 0
      );
    })
  );
}

function formatCodexNativeSandboxBlock(params: { surface: string }): string {
  return [
    `Codex-native ${params.surface} is unavailable because OpenClaw sandboxing is active for this session.`,
    "This mode cannot route execution through the OpenClaw sandbox backend.",
    "Use a normal Codex harness turn, or run an intentionally unsandboxed session.",
  ].join(" ");
}

function resolveCodexNativeNodeExecBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  surface: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  const policy = resolveCodexNativeExecutionPolicy({
    config: params.config,
    sessionKey,
    readRuntimeSessionEntry: Boolean(sessionKey),
  });
  if (policy.nativeToolSurfaceAllowed) {
    return undefined;
  }
  return formatCodexNativeNodeExecBlock({
    surface: params.surface,
    reason: policy.blockReason,
  });
}
