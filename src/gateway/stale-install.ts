import { fileURLToPath } from "node:url";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";

export const GATEWAY_STALE_INSTALL_CLOSE_REASON =
  "gateway install changed; run: openclaw gateway restart";

// The install root is process-stable; capture it before an upgrade can replace
// package metadata, then consult it only after a dynamic import has failed.
const gatewayInstallRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });

type GatewayStaleInstall = {
  error: ErrorShape;
  restartCommand: string;
};

export function classifyGatewayStaleInstall(error: unknown): GatewayStaleInstall | null {
  if (
    !gatewayInstallRoot ||
    !(error instanceof Error) ||
    !hasNodeErrorCode(error, "ERR_MODULE_NOT_FOUND")
  ) {
    return null;
  }
  const url = (error as Error & { url?: unknown }).url;
  if (typeof url !== "string") {
    return null;
  }
  let missingPath: string;
  try {
    missingPath = fileURLToPath(url);
  } catch {
    return null;
  }
  if (!isPathInside(gatewayInstallRoot, missingPath)) {
    return null;
  }
  const restartCommand = formatCliCommand("openclaw gateway restart");
  return {
    error: errorShape(
      ErrorCodes.UNAVAILABLE,
      `The running Gateway can no longer load part of its OpenClaw installation. The installation may have changed while the Gateway was running. Restart it with: ${restartCommand}`,
      { details: { code: "STALE_INSTALL", restartCommand }, retryable: false },
    ),
    restartCommand,
  };
}
