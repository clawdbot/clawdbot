// Proxy capture path helpers resolve capture directories and database paths.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// Debug proxy capture artifacts live under OpenClaw state so DB, blobs, and CA
// files are grouped and easy to purge.
function resolveDebugProxyRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "debug-proxy");
}

export function resolveDebugProxyDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "capture.sqlite");
}

export function resolveDebugProxyBlobDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "blobs");
}

export function resolveDebugProxyCertDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "certs");
}
