import fs from "node:fs";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveUserPath } from "../../utils.js";

type PreparedSessionCreateRoot = {
  sessionCwd?: string;
  sessionRoot?: string;
};

export function prepareSessionCreateFilesystemRoot(params: {
  cfg: OpenClawConfig;
  requestedExecNode?: string;
  requestedProjectId?: string;
  enforceSandboxContainment: boolean;
  sessionCwd?: string;
  sessionKey?: string;
  targetAgentId: string;
}): Result<PreparedSessionCreateRoot, ErrorShape> {
  if (params.requestedExecNode) {
    return ok({ sessionCwd: params.sessionCwd });
  }
  if (params.sessionCwd && params.enforceSandboxContainment) {
    const targetRuntime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      sessionKey: params.sessionKey ?? `agent:${params.targetAgentId}:dashboard:pending`,
    });
    if (
      targetRuntime.sandboxed &&
      !isPathInside(
        resolveUserPath(resolveAgentWorkspaceDir(params.cfg, params.targetAgentId)),
        resolveUserPath(params.sessionCwd),
      )
    ) {
      return err(
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          params.requestedProjectId
            ? "sessions.create project is outside the sandboxed agent workspace"
            : "sessions.create cwd is outside the sandboxed agent workspace",
        ),
      );
    }
  }
  const rootCandidate =
    params.sessionCwd ?? resolveAgentWorkspaceDir(params.cfg, params.targetAgentId);
  try {
    if (!params.sessionCwd) {
      fs.mkdirSync(rootCandidate, { recursive: true });
    }
    const sessionRoot = fs.realpathSync(rootCandidate);
    if (!fs.statSync(sessionRoot).isDirectory()) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd is not a directory"));
    }
    return ok({ sessionRoot, sessionCwd: params.sessionCwd ? sessionRoot : undefined });
  } catch (error) {
    return err(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `sessions.create cwd is unavailable: ${formatErrorMessage(error)}`,
      ),
    );
  }
}
