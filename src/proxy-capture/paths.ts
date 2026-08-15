// Proxy capture path helpers resolve certificate artifacts.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// Debug proxy CA files live under OpenClaw state. Capture data lives in the
// shared global state database.
function resolveDebugProxyRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "debug-proxy");
}

/** @deprecated Capture storage now lives in the shared state database. */
export function resolveDebugProxyDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "capture.sqlite");
}

/** @deprecated Capture payloads now live in the shared state database. */
export function resolveDebugProxyBlobDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "blobs");
}

export function resolveDebugProxyCertDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "certs");
}
