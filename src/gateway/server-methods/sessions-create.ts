// Session creation, initial turns, and managed-worktree provisioning.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  buildDashboardSessionTitleSource,
  generateWorktreeSessionTitle,
  resolveExplicitSessionName,
} from "../dashboard-session-title.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { buildDashboardSessionKey, createGatewaySession } from "../session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "../session-lifecycle-preparation.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import { prepareSessionWorktree } from "../session-worktree-preparation.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { chatHandlers } from "./chat.js";
import { resolveRegisteredCatalogCreateTarget } from "./session-catalog.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCreatedSessionCategory } from "./session-create-category.js";
import { idempotentSessionCreate } from "./session-create-idempotency.js";
import {
  resolveSessionCreateInitialTurn,
  isFreshChatSendStarted,
} from "./session-create-initial-turn.js";
import {
  normalizeSessionProjectGitUrl,
  validateSessionProjectPreparation,
} from "./session-create-project.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

function resolveSpawnParentWorktreeSource(
  parentSessionKey: string,
  agentId: string,
  assertCallerCurrent: (() => void) | undefined,
) {
  const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, { agentId });
  if (!parent.entry?.worktree) {
    return undefined;
  }
  const worktree = managedWorktrees.findLiveByOwner("session", parent.canonicalKey);
  if (
    !worktree ||
    worktree.id !== parent.entry.worktree.id ||
    parent.entry.archivedAt !== undefined
  ) {
    throw new Error("Spawn parent managed worktree changed; retry from its current session");
  }
  const parentSessionId = parent.entry.sessionId;
  // Validate the inherited source through the child creation commit. After that,
  // persisted workspace intent belongs to the child and uses its admitted run.
  const assertCurrent = () => {
    assertCallerCurrent?.();
    const current = loadGatewaySessionEntryReadOnly(parent.canonicalKey, { agentId });
    const currentWorktree = managedWorktrees.findLiveByOwner("session", parent.canonicalKey);
    if (
      current.entry?.sessionId !== parentSessionId ||
      current.entry.archivedAt !== undefined ||
      current.entry.worktree?.id !== worktree.id ||
      currentWorktree?.id !== worktree.id ||
      currentWorktree.repoRoot !== worktree.repoRoot ||
      currentWorktree.path !== worktree.path
    ) {
      throw new Error("Spawn parent managed worktree changed; retry from its current session");
    }
  };
  return { workspace: worktree.repoRoot, assertCurrent };
}

export const sessionCreateHandlers: GatewayRequestHandlers = {
  "sessions.create": async ({
    req,
    params,
    respond,
    context,
    client,
    isWebchatConnect,
    sessionMutationCommitGuard,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
    const sessionCreation = resolveOperatorSessionCreation(client, { allowTrustedHint: true });
    const spawnRequesterSessionKey =
      sessionCreation.via === "spawn"
        ? normalizeOptionalString(sessionCreation.requesterSessionKey)
        : undefined;
    if (sessionCreation.inheritedToolPolicy && parentSessionKey !== spawnRequesterSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spawn parent must match the trusted agent caller"),
      );
      return;
    }
    const requestedModel = normalizeOptionalString(p.model);
    const cfg = context.getRuntimeConfig();
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond);
    let commitGuard =
      authority.commitGuard || sessionMutationCommitGuard || sessionMutationAuthorization
        ? () => {
            sessionMutationCommitGuard?.();
            authority.commitGuard?.();
            sessionMutationAuthorization?.assertCurrent();
          }
        : undefined;
    const catalogId = normalizeOptionalString(p.catalogId);
    const catalogConflict = p.model ? "model" : p.key ? "key" : undefined;
    if (catalogId && catalogConflict) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.create catalogId cannot include ${catalogConflict}`,
        ),
      );
      return;
    }
    const explicitlyRequestedKey = normalizeOptionalString(p.key);
    const explicitlyRequestedAgentId = normalizeOptionalString(p.agentId);
    // An omitted key means the selected agent's main alias, not the compatibility owner's alias.
    const agentSelectionKey =
      explicitlyRequestedKey ??
      (explicitlyRequestedAgentId
        ? `agent:${normalizeAgentId(explicitlyRequestedAgentId)}:main`
        : "main");
    const explicitlyRequestedAgent = resolveRequestedGlobalAgentId(
      cfg,
      agentSelectionKey,
      p.agentId ?? parseAgentSessionKey(explicitlyRequestedKey)?.agentId,
    );
    if (!explicitlyRequestedAgent.ok) {
      respond(false, undefined, explicitlyRequestedAgent.error);
      return;
    }
    const catalogRequestedKey = normalizeOptionalString(p.key) ?? "global";
    const catalogAgentId = catalogId
      ? normalizeAgentId(
          parseAgentSessionKey(catalogRequestedKey)?.agentId ?? explicitlyRequestedAgent.agentId,
        )
      : undefined;
    const catalogTarget =
      catalogId && catalogAgentId
        ? resolveRegisteredCatalogCreateTarget(catalogId, catalogAgentId, cfg)
        : undefined;
    if (catalogTarget && !catalogTarget.ok) {
      respond(
        false,
        undefined,
        errorShape(
          catalogTarget.unknownCatalog ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          catalogTarget.message,
        ),
      );
      return;
    }
    const initialTurn = resolveSessionCreateInitialTurn(p);
    if (!initialTurn) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create attachments require usable content",
        ),
      );
      return;
    }
    const {
      attachments: initialAttachments,
      hasInitialTurn,
      message: initialMessage,
    } = initialTurn;
    let requestedCwd = normalizeOptionalString(p.cwd);
    const requestedExecNode = normalizeOptionalString(p.execNode);
    const requestedProjectId = normalizeOptionalString(p.projectId);
    const requestedProjectGitUrl = p.projectGitUrl;
    const projectPreparationError = validateSessionProjectPreparation({
      cwd: requestedCwd,
      execNode: requestedExecNode,
      gitUrl: requestedProjectGitUrl,
      hasInitialTurn,
      projectId: requestedProjectId,
    });
    if (projectPreparationError) {
      respond(false, undefined, projectPreparationError);
      return;
    }
    // Agent tools expand `~` before RPC; the Gateway contract stays absolute-only.
    // Remote nodes may use Windows paths; local cwd must match the Gateway host.
    const cwdIsAbsolute =
      !requestedCwd ||
      (requestedExecNode
        ? path.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd)
        : path.isAbsolute(requestedCwd));
    if (!cwdIsAbsolute) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd must be absolute"),
      );
      return;
    }
    const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    if (p.permissionMode === "full" && client !== null && !clientScopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
      );
      return;
    }
    if (requestedCwd && !requestedExecNode && !clientScopes.includes(ADMIN_SCOPE)) {
      const containment = await resolveWorkspacePathContainment(requestedCwd, cfg);
      if (!containment) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({
            missingScope: ADMIN_SCOPE,
            requiredScopes: [ADMIN_SCOPE],
          }),
        );
        return;
      }
      requestedCwd = containment.path;
    }
    if (requestedExecNode && p.worktree === true) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create worktree cannot target execNode"),
      );
      return;
    }
    const requestedWorktreeBaseRef = normalizeOptionalString(p.worktreeBaseRef);
    const requestedWorktreeName = normalizeOptionalString(p.worktreeName);
    if ((requestedWorktreeBaseRef || requestedWorktreeName) && p.worktree !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create worktreeBaseRef/worktreeName require worktree=true",
        ),
      );
      return;
    }
    const explicitSessionLabel = normalizeOptionalString(p.label);
    const titleAgentId = explicitlyRequestedAgent.agentId;
    const existingWorktreeTarget =
      p.worktree === true && explicitlyRequestedKey
        ? loadGatewaySessionEntryReadOnly(explicitlyRequestedKey, { agentId: titleAgentId }).entry
        : undefined;
    const deferWorktree = p.worktree === true && hasInitialTurn && !existingWorktreeTarget;
    let projectRoot: string | undefined;
    if (requestedProjectId) {
      const project = resolveProjectRegistry(cfg, requestedProjectId);
      if (!project) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${requestedProjectId}`),
        );
        return;
      }
      try {
        const checkout =
          p.worktree === true ? await resolveProjectCheckout(project.repoRoot) : undefined;
        projectRoot = checkout?.path ?? (await resolveProjectDirectory(project.repoRoot));
        if (checkout && project.source !== "workspace" && checkout.path !== checkout.repoRoot) {
          throw new ProjectCheckoutError(`project root is no longer a git checkout`);
        }
      } catch (error) {
        const detail =
          error instanceof ProjectCheckoutError ? error.message : formatErrorMessage(error);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `project ${requestedProjectId} is unavailable (${detail}); update the agent workspace path or re-register the project`,
          ),
        );
        return;
      }
    }
    let sessionKey = p.key;
    let sessionAgentId = catalogAgentId ?? explicitlyRequestedAgent.agentId;
    let preparedWorktree: PreparedGatewaySessionLifecycle | undefined;
    let pendingWorktree: InternalSessionEntry["pendingWorktree"];
    const sessionExecCwd = requestedExecNode ? requestedCwd : undefined;
    let sessionCwd = requestedExecNode ? undefined : (projectRoot ?? requestedCwd);
    let prepareLifecycle: Parameters<typeof createGatewaySession>[0]["prepareLifecycle"];
    const preparedRoot = prepareSessionCreateFilesystemRoot({
      cfg,
      enforceSandboxContainment: Boolean(
        sessionCwd && !requestedExecNode && (requestedProjectId || p.worktree !== true),
      ),
      requestedExecNode,
      requestedProjectId,
      sessionCwd,
      sessionKey,
      targetAgentId: sessionAgentId,
    });
    if (!preparedRoot.ok) {
      respond(false, undefined, preparedRoot.error);
      return;
    }
    sessionCwd = preparedRoot.value.sessionCwd;
    const sessionRoot = preparedRoot.value.sessionRoot;
    if (p.worktree === true) {
      // Workspace-contained cwd and registry-authorized projects stay at operator.write;
      // arbitrary host paths still require operator.admin before reaching this block.
      const explicitKey = explicitlyRequestedKey;
      const agentId = explicitlyRequestedAgent.agentId;
      let targetKey = explicitKey;
      let preservesUnspecifiedKey = false;
      if (
        !targetKey &&
        parentSessionKey &&
        p.emitCommandHooks === true &&
        !hasInitialTurn &&
        cfg.session?.dmScope === "main"
      ) {
        const parentRequestedAgent = resolveRequestedGlobalAgentId(cfg, parentSessionKey, agentId);
        if (!parentRequestedAgent.ok) {
          respond(false, undefined, parentRequestedAgent.error);
          return;
        }
        const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, {
          agentId: parentRequestedAgent.agentId,
        });
        const parentAgentId = parentRequestedAgent.agentId;
        if (
          parent.entry?.sessionId &&
          parent.canonicalKey === resolveAgentMainSessionKey({ cfg, agentId: parentAgentId })
        ) {
          targetKey = parent.canonicalKey;
          preservesUnspecifiedKey = true;
        }
      }
      targetKey ??= buildDashboardSessionKey(agentId);
      const target = resolveGatewaySessionStoreTarget({ cfg, key: targetKey, agentId });
      sessionKey = preservesUnspecifiedKey ? undefined : targetKey;
      sessionAgentId = target.agentId;
      const inheritParentWorktree =
        !projectRoot &&
        !requestedCwd &&
        !requestedProjectGitUrl &&
        spawnRequesterSessionKey &&
        spawnRequesterSessionKey === parentSessionKey &&
        sessionCreation.actor?.type === "agent" &&
        normalizeAgentId(sessionCreation.actor.id) === target.agentId;
      const inheritedSource = inheritParentWorktree
        ? resolveSpawnParentWorktreeSource(spawnRequesterSessionKey, target.agentId, commitGuard)
        : undefined;
      commitGuard = inheritedSource?.assertCurrent ?? commitGuard;
      const workspace =
        projectRoot ??
        requestedCwd ??
        inheritedSource?.workspace ??
        resolveAgentWorkspaceDir(cfg, target.agentId);
      // Subdirectory workspaces are valid: the worktree service resolves the repo root
      // via git discovery, so the preflight must accept ancestor .git entries too.
      if (!requestedProjectGitUrl && !insideGitCheckout(workspace)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
        );
        return;
      }
      if (deferWorktree) {
        // Persist intent before slow naming/Git/setup. The admitted turn binds the
        // checkout, so failed or interrupted preparation can retry in this session.
        pendingWorktree = {
          ...(requestedProjectGitUrl ? {} : { workspace }),
          name: requestedWorktreeName,
          baseRef: requestedWorktreeBaseRef,
          titleSource: buildDashboardSessionTitleSource({
            message: initialMessage ?? "",
            attachments: initialAttachments,
          }),
        };
      } else {
        prepareLifecycle = async (lifecycleTarget) => {
          const source = buildDashboardSessionTitleSource({
            message: initialMessage ?? "",
            attachments: initialAttachments,
          });
          // New prompt-bearing sessions use pendingWorktree. Empty creates have no
          // title source or persisted generation until the lifecycle owner commits.
          const title =
            !requestedWorktreeName &&
            !explicitSessionLabel &&
            lifecycleTarget.entry &&
            lifecycleTarget.titleModelSelection !== null
              ? await generateWorktreeSessionTitle({
                  cfg,
                  agentId: lifecycleTarget.agentId,
                  entry: requestedModel
                    ? { ...lifecycleTarget.entry, ...lifecycleTarget.titleModelSelection }
                    : lifecycleTarget.entry,
                  sessionId: lifecycleTarget.entry.sessionId,
                  sessionKey: lifecycleTarget.key,
                  storePath: lifecycleTarget.storePath,
                  currentUserMessage: initialMessage,
                  userMessage: source,
                  commitGuard,
                  onError: (error) =>
                    sessionLog.warn(`worktree title failed: ${formatErrorMessage(error)}`),
                  onPersisted: () =>
                    emitSessionsChanged(context, {
                      sessionKey: lifecycleTarget.key,
                      agentId: lifecycleTarget.agentId,
                      reason: "chat.title",
                    }),
                })
              : undefined;
          const prepared = await prepareSessionWorktree({
            target: lifecycleTarget,
            workspace,
            name: requestedWorktreeName,
            baseRef: requestedWorktreeBaseRef,
            label:
              explicitSessionLabel ??
              title ??
              resolveExplicitSessionName(lifecycleTarget.entry) ??
              source,
            runSetupScript: clientScopes.includes(ADMIN_SCOPE),
            commitGuard,
          });
          if (prepared.ok) {
            preparedWorktree = prepared.value;
          }
          return prepared;
        };
      }
    }
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    const allowExistingModelSelection = authorizeOperatorScopesForRequiredScope(
      ADMIN_SCOPE,
      clientScopes,
    ).allowed;
    const modelCatalogAgentId = sessionAgentId;
    if (!authority.ensureActive()) {
      return;
    }
    const created = await createGatewaySession({
      cfg,
      key: sessionKey,
      agentId: sessionAgentId,
      label: p.label,
      category: p.category,
      ...(catalogTarget ? { catalogTarget: catalogTarget.target } : { model: requestedModel }),
      contextWindow: p.contextWindow,
      thinkingLevel: p.thinkingLevel,
      fastMode: p.fastMode,
      projectId: requestedProjectId,
      pendingProjectGitUrl: normalizeSessionProjectGitUrl(requestedProjectGitUrl),
      pendingWorktree,
      incognito: p.incognito,
      ...(client?.connect ? { requestingOperatorScopes: clientScopes } : {}),
      ...(client?.authenticatedUserProfile
        ? { requestingOperatorProfileId: client.authenticatedUserProfile.profileId }
        : {}),
      ...(client?.internal?.operatorRoleActor
        ? { operatorRoleActor: client.internal.operatorRoleActor }
        : {}),
      visibility: p.visibility,
      allowExistingModelSelection,
      parentSessionKey,
      spawnDepth: p.spawnDepth,
      spawnToolPolicy:
        sessionCreation.via === "spawn" && sessionCreation.inheritedToolPolicy
          ? {
              ...sessionCreation.inheritedToolPolicy,
              ...(sessionCreation.completionOwnerSessionKey
                ? { completionOwnerSessionKey: sessionCreation.completionOwnerSessionKey }
                : {}),
            }
          : undefined,
      spawnedCwd: p.worktree === true ? undefined : sessionCwd,
      sessionRoot: p.worktree === true ? undefined : sessionRoot,
      permissionMode: p.permissionMode,
      ...(p.toolOverrides !== undefined ? { toolOverrides: p.toolOverrides } : {}),
      prepareLifecycle,
      onLifecycleCleanupError: (error) => {
        sessionLog.warn(
          `failed to finalize session worktree lifecycle: ${formatErrorMessage(error)}`,
        );
      },
      execNode: requestedExecNode,
      execCwd: sessionExecCwd,
      clearExecBinding: !requestedExecNode,
      // A plain New Chat with no cwd must not inherit the prior session cwd.
      clearSpawnedCwd: p.worktree !== true && !sessionCwd,
      fork: p.fork,
      forkFrom: p.forkFrom,
      succeedsParent: p.succeedsParent,
      emitCommandHooks: p.emitCommandHooks,
      resetMainWhenUnspecified: !hasInitialTurn,
      commandSource: "webchat",
      creation: sessionCreation,
      authorizedPluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
      armSessionDiffBaselineCapture: true,
      loadGatewayModelCatalog: () =>
        context.loadGatewayModelCatalog({ agentId: modelCatalogAgentId }),
      ...(commitGuard ? { commitGuard } : {}),
      afterCreate: async ({ key, agentId }) => {
        if (!authority.hasActive()) {
          return;
        }
        if (hasInitialTurn) {
          if (!authority.hasActive()) {
            return;
          }
          await expectDefined(
            chatHandlers["chat.send"],
            "chat.send handler",
          )({
            req,
            params: {
              sessionKey: key,
              agentId,
              message: initialMessage ?? "",
              idempotencyKey: randomUUID(),
              ...(initialAttachments ? { attachments: initialAttachments } : {}),
            },
            respond: (ok, payload, error, meta) => {
              if (ok && payload && typeof payload === "object") {
                runPayload = payload as Record<string, unknown>;
              } else {
                runError = error;
              }
              runMeta = meta;
            },
            context,
            client,
            isWebchatConnect,
          });
        }
      },
    }).catch((error: unknown) => authority.handleClosedError(error));
    if (!created) {
      return;
    }
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    if (created.postCommit.status === "failed") {
      runError = errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(created.postCommit.error));
    }
    registerCreatedSessionCategory(normalizeOptionalString(p.category), context);
    const createdWorktree = preparedWorktree?.worktree
      ? {
          id: preparedWorktree.worktree.id,
          path: preparedWorktree.sessionRoot,
          branch: preparedWorktree.worktree.branch,
        }
      : undefined;
    const responseEntry = sessionEntryForkedFromParent(created.entry)
      ? { ...created.entry, forkedFromParent: true as const }
      : created.entry;
    if (created.resetExisting) {
      respond(
        true,
        {
          ok: true,
          key: created.key,
          sessionId: created.entry.sessionId,
          entry: responseEntry,
          resolved: created.resolved,
          runStarted: false,
          ...(createdWorktree ? { worktree: createdWorktree } : {}),
        },
        undefined,
      );
      emitSessionsChanged(context, {
        sessionKey: created.key,
        agentId: created.agentId,
        reason: "new",
      });
      return;
    }

    const runStarted =
      runPayload !== undefined &&
      isFreshChatSendStarted({
        payload: runPayload,
        cached: runMeta?.cached === true,
      });

    respond(
      true,
      {
        ok: true,
        key: created.key,
        sessionId: created.entry.sessionId,
        entry: responseEntry,
        runStarted,
        ...(runPayload ? runPayload : {}),
        ...(runError ? { runError } : {}),
        resolved: created.resolved,
        ...(createdWorktree ? { worktree: createdWorktree } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: created.key,
      agentId: created.agentId,
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: created.key,
        agentId: created.agentId,
        reason: "send",
      });
    }
  },
};

sessionCreateHandlers["sessions.create"] = idempotentSessionCreate(
  expectDefined(sessionCreateHandlers["sessions.create"], "sessions.create handler"),
);
