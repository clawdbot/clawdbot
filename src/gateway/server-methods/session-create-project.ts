import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { materializeProjectClone } from "../../projects/project-clone.js";
import { parseProjectGitUrl } from "../../projects/project-git-url.js";
import { resolveProjectDirectory } from "../../projects/project-registry.js";
import { githubApiToken } from "../control-ui-github-api.js";
import { hasActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const SESSION_PROJECT_OWNERSHIP_ERROR =
  "Session changed while preparing its project; retry the task.";

export function normalizeSessionProjectGitUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 2048
    ? parseProjectGitUrl(value)?.url
    : undefined;
}

export function validateSessionProjectPreparation(params: {
  cwd?: string;
  execNode?: string;
  gitUrl?: string;
  hasInitialTurn: boolean;
  projectId?: string;
  worktree: boolean;
}): ErrorShape | undefined {
  if (!params.gitUrl) {
    return params.projectId && (params.cwd || params.execNode)
      ? errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create projectId cannot be combined with cwd or execNode",
        )
      : undefined;
  }
  if (!normalizeSessionProjectGitUrl(params.gitUrl)) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    );
  }
  if (params.projectId || params.cwd || params.execNode || params.worktree) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create projectGitUrl cannot be combined with projectId, cwd, execNode, or worktree",
    );
  }
  return params.hasInitialTurn
    ? undefined
    : errorShape(
        ErrorCodes.INVALID_REQUEST,
        "sessions.create projectGitUrl requires an initial turn",
      );
}

/** Bind a persisted remote intent only while its exact admitted run remains authoritative. */
export async function prepareSessionProjectWorkspace(params: {
  admission: AdmittedChatSend;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  session: PreparedChatSendSession;
}): Promise<() => void> {
  const { admission, client, context, session } = params;
  const { entry, cfg, agentId, clientRunId, sessionKey, storePath } = session;
  const gitUrl = normalizeSessionProjectGitUrl(entry?.pendingProjectGitUrl);
  if (!entry || !gitUrl || gitUrl !== entry.pendingProjectGitUrl) {
    throw new Error("Saved project repository is invalid; select the repository and retry.");
  }
  const { controller } = admission.activeRunAbort;
  const signal = controller.signal;
  const assertRunOwnership = () => {
    signal.throwIfAborted();
    const activeRun = context.chatAbortControllers.get(clientRunId);
    if (
      !activeRun ||
      activeRun !== admission.activeRunAbort.entry ||
      activeRun.controller !== controller ||
      activeRun.sessionKey !== sessionKey ||
      activeRun.sessionId !== entry.sessionId ||
      entry.sessionId !== admission.admittedSessionId ||
      activeRun.lifecycleGeneration !== admission.lifecycleGeneration ||
      activeRun.projectSessionActive === false ||
      activeRun.projectSessionTerminalPending === true ||
      activeRun.projectSessionTerminalPersisted === true ||
      !hasActiveAgentRuntimeAuthority(client, context)
    ) {
      throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
    }
    assertAgentRunLifecycleGenerationCurrent(admission.lifecycleGeneration);
  };
  assertRunOwnership();
  emitAgentRunStatusEvent({
    runId: clientRunId,
    sessionKey,
    agentId,
    phase: "preparing_workspace",
  });
  const project = await materializeProjectClone(
    { cfg, gitUrl },
    { signal, token: githubApiToken(process.env, cfg) },
  );
  assertRunOwnership();
  const directory = await resolveProjectDirectory(project.repoRoot);
  assertRunOwnership();
  const prepared = prepareSessionCreateFilesystemRoot({
    cfg,
    enforceSandboxContainment: true,
    requestedProjectId: project.id,
    sessionCwd: directory,
    sessionKey,
    targetAgentId: agentId,
  });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const bound = await patchSessionEntryCore(
    { agentId, sessionKey, storePath },
    (current) => {
      assertRunOwnership();
      if (
        current.sessionId !== entry.sessionId ||
        current.pendingProjectGitUrl !== gitUrl ||
        (current.projectId && current.projectId !== project.id)
      ) {
        throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
      }
      return {
        projectId: project.id,
        sessionRoot: prepared.value.sessionRoot,
        spawnedCwd: prepared.value.sessionCwd,
        pendingProjectGitUrl: undefined,
      };
    },
    { assertCommitAllowed: assertRunOwnership, requireWriteSuccess: true, skipMaintenance: true },
  );
  assertRunOwnership();
  if (!bound) {
    throw new Error("Session disappeared while preparing its project; start a new session.");
  }
  Object.assign(entry, bound);
  // JSON omits the cleared key, so assigning the bound entry alone would retain stale intent.
  delete entry.pendingProjectGitUrl;
  emitSessionsChanged(context, { sessionKey, agentId, reason: "project" });
  return assertRunOwnership;
}
