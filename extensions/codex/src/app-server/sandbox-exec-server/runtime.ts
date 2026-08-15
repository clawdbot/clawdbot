/**
 * Runtime guards for sandbox exec-server handlers that need backend-specific
 * execution and filesystem bridges.
 */
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import type { OpenClawExecServer } from "./types.js";

/** Returns the configured sandbox backend or fails the current JSON-RPC request. */
export function requireBackend(
  execServer: OpenClawExecServer,
): NonNullable<SandboxContext["backend"]> {
  const backend = execServer.sandbox.backend;
  if (!backend) {
    throw new Error("OpenClaw sandbox backend is unavailable.");
  }
  return backend;
}

/** Returns the configured filesystem bridge or fails the current JSON-RPC request. */
export function requireFsBridge(
  execServer: OpenClawExecServer,
): NonNullable<SandboxContext["fsBridge"]> {
  const fsBridge = execServer.sandbox.fsBridge;
  if (!fsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
  return fsBridge;
}
