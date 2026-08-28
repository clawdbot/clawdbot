import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { materializeProjectClone } from "../../projects/project-clone.js";
import { parseProjectGitUrl } from "../../projects/project-git-url.js";
import { resolveProjectDirectory } from "../../projects/project-registry.js";
import { githubApiToken } from "../control-ui-github-api.js";
import { prepareWorktreeSessionTitle } from "../dashboard-session-title.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { PreparedGatewaySessionLifecycle } from "../session-lifecycle-preparation.js";
import { prepareSessionWorktree } from "../session-worktree-preparation.js";
import { hasActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const SESSION_PROJECT_OWNERSHIP_ERROR =
  "Session changed while preparing its project; retry the task.";
const workspacePreparations = new KeyedAsyncQueue();

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
  if (params.projectId || params.cwd || params.execNode) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create projectGitUrl cannot be combined with projectId, cwd, or execNode",
    );
  }
  return params.hasInitialTurn
    ? undefined
    : errorShape(
        ErrorCodes.INVALID_REQUEST,
        "sessions.create projectGitUrl requires an initial turn",
      );
}

/** Bind persisted workspace intent only while its exact admitted run remains authoritative. */
export async function prepareSessionWorkspace(params: {
  admission: AdmittedChatSend;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  session: PreparedChatSendSession;
}): Promise<() => void> {
  const { admission, client, context, session } = params;
  const { entry, cfg, agentId, clientRunId, sessionKey, storePath } = session;
  if (!entry) {
    throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
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
  // Serialize through binding/rollback, not just Git allocation. A second send
  // must never roll back a checkout already adopted by the first admitted run.
  await workspacePreparations.enqueue(`${storePath}\0${sessionKey}`, async () => {
    assertRunOwnership();
    const target = { agentId, sessionKey, storePath };
    const saved = loadSessionEntry(target);
    if (!saved || saved.sessionId !== entry.sessionId) {
      throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
    }
    const pending = saved.pendingWorktree;
    const gitUrl = normalizeSessionProjectGitUrl(saved.pendingProjectGitUrl);
    if (
      Object.hasOwn(saved, "pendingProjectGitUrl") &&
      (!gitUrl || gitUrl !== saved.pendingProjectGitUrl)
    ) {
      throw new Error("Saved project repository is invalid; select the repository and retry.");
    }
    if (!pending && !gitUrl) {
      Object.assign(entry, saved);
      delete entry.pendingProjectGitUrl;
      delete entry.pendingWorktree;
      return;
    }
    const project = gitUrl
      ? await materializeProjectClone(
          { cfg, gitUrl },
          { signal, token: githubApiToken(process.env, cfg) },
        )
      : undefined;
    assertRunOwnership();
    const directory = project
      ? await resolveProjectDirectory(project.repoRoot)
      : pending?.workspace;
    assertRunOwnership();
    if (!directory) {
      throw new Error("Saved worktree workspace is invalid; select the repository and retry.");
    }
    const root = prepareSessionCreateFilesystemRoot({
      cfg,
      enforceSandboxContainment: Boolean(project),
      requestedProjectId: project?.id,
      sessionCwd: directory,
      sessionKey,
      targetAgentId: agentId,
    });
    if (!root.ok) {
      throw new Error(root.error.message);
    }
    const status = (phase: Parameters<typeof emitAgentRunStatusEvent>[0]["phase"]) => {
      assertRunOwnership();
      emitAgentRunStatusEvent({ runId: clientRunId, sessionKey, agentId, phase });
    };
    const needsTitle = pending && !pending.name && !saved.label && !saved.displayName;
    if (needsTitle) {
      status("naming_worktree");
    }
    const title = needsTitle
      ? prepareWorktreeSessionTitle({
          cfg,
          agentId,
          entry: saved,
          userMessage: pending.titleSource,
          onError: (error) => context.logGateway.warn(`worktree title failed: ${String(error)}`),
        })
      : undefined;
    let prepared: PreparedGatewaySessionLifecycle = {
      spawnedCwd: root.value.sessionCwd,
      sessionRoot: root.value.sessionRoot,
    };
    if (pending) {
      // Retries inherit workspace intent, not a previous caller's setup authority.
      const result = await prepareSessionWorktree({
        target: { ...target, key: sessionKey, entry: saved },
        workspace: directory,
        name: pending.name,
        baseRef: pending.baseRef,
        label: saved.label ?? saved.displayName,
        title,
        runSetupScript: client?.connect?.scopes?.includes(ADMIN_SCOPE) === true,
        signal,
        commitGuard: assertRunOwnership,
        onProgress: (stage) => status(stage === "setup" ? "running_setup" : "creating_worktree"),
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      prepared = result.value;
    }
    let bound;
    try {
      bound = await patchSessionEntryCore(
        target,
        (current) => {
          assertRunOwnership();
          if (
            current.sessionId !== entry.sessionId ||
            current.projectId !== saved.projectId ||
            current.pendingProjectGitUrl !== saved.pendingProjectGitUrl ||
            !isDeepStrictEqual(current.pendingWorktree, pending)
          ) {
            throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
          }
          return {
            ...(project ? { projectId: project.id } : {}),
            sessionRoot: prepared.sessionRoot,
            spawnedCwd: prepared.spawnedCwd,
            ...(prepared.worktree ? { worktree: prepared.worktree } : {}),
            pendingProjectGitUrl: undefined,
            pendingWorktree: undefined,
          };
        },
        {
          assertCommitAllowed: assertRunOwnership,
          requireWriteSuccess: true,
          skipMaintenance: true,
        },
      );
      if (!bound) {
        throw new Error("Session disappeared while preparing its workspace; start a new session.");
      }
    } catch (error) {
      await prepared.rollback?.();
      throw error;
    }
    // Once committed the session, not this run, owns the checkout; abort must
    // retain it for retry and must not roll it back after publication.
    Object.assign(entry, bound);
    delete entry.pendingProjectGitUrl;
    delete entry.pendingWorktree;
    assertRunOwnership();
    emitSessionsChanged(context, { sessionKey, agentId, reason: "project" });
    if (await title?.persist(agentId, entry, sessionKey, storePath)) {
      emitSessionsChanged(context, { sessionKey, agentId, reason: "chat.title" });
    }
  });
  assertRunOwnership();
  return assertRunOwnership;
}
