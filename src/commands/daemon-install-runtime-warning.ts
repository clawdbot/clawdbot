// Runtime warning helpers for daemon install plans that depend on Node.
import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type DaemonInstallWarnFn = (message: string, title?: string) => void;

/** Warn when daemon install will use a system Node path that may be unsuitable. */
export async function emitNodeRuntimeWarning(params: {
  env: Record<string, string | undefined>;
  runtime: GatewayDaemonRuntime;
  nodeProgram?: string;
  warn?: DaemonInstallWarnFn;
  title: string;
}): Promise<void> {
  const systemNode = await resolveSystemNodeInfo({ env: params.env });
  const warning = renderSystemNodeWarning(systemNode, params.nodeProgram);
  if (warning) {
    params.warn?.(warning, params.title);
  }
}
