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
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import {
  buildDashboardSessionTitleSource,
  generateWorktreeSessionTitle,
  resolveExplicitSessionName,
} from "../dashboard-session-title.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { buildDashboardSessionKey, createGatewaySession } from "../session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "../session-lifecycle-preparation.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import {
  prepareSessionWorktree,
  resolveSpawnParentWorktreeSource,
} from "../session-worktree-preparation.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
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
  prepareSessionRepositoryWorkspace,
  resolveSessionRepositoryCreation,
  validateSessionProjectPreparation,
} from "./session-create-project.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { prepareSessionModelAccountAccess } from "./users-model-account-access.js";
import { assertValidParams } from "./validation.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

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
    signal,
  }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
    const sessionCreation = prepareSkillLibrarySessionCreation(
      client,
      context.getRuntimeConfig,
      resolveOperatorSessionCreation(client, { allowTrustedHint: true }),
    );
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
    let personalAccounts: ReturnType<typeof prepareSessionModelAccountAccess>;
    try {
      personalAccounts = prepareSessionModelAccountAccess(
        { client, context, signal },
        requestedModel,
      );
    } catch (error) {
      if (!(error instanceof ModelAccountConnectAuthorityError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
      return;
    }
    const { personalModelSelection, personalAccountDefaults } = personalAccounts;
    const cfg = context.getRuntimeConfig();
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond);
    // Both uncommitted selections must remain authorized after awaited preparation.
    let commitGuard = () => {
      sessionMutationCommitGuard?.();
      authority.commitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
      assertPreparedSkillLibrarySelection(sessionCreation.skillLibrarySelections);
      personalModelSelection?.assertCurrent();
      personalAccountDefaults?.assertCurrent();
    };
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
    const explicitlyRequestedAgent = resolveRequestedGlobalAgentId(
      cfg,
      explicitlyRequestedKey ?? (p.agentId === undefined ? "main" : undefined),
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
    const repositoryCreation = resolveSessionRepositoryCreation(p, hasInitialTurn);
    if (!repositoryCreation.ok) {
      respond(false, undefined, repositoryCreation.error);
      return;
    }
    const repository = repositoryCreation.value;
    let sessionKey = explicitlyRequestedKey;
    const initialRunId = randomUUID();
    if (p.mentions?.length) {
      if (catalogId || p.incognito) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Human mentions are unavailable for this session mode. Remove the selected mentions to continue.",
          ),
        );
        return;
      }
      // Mention validation and later creation must use the same real child target.
      sessionKey ??= buildDashboardSessionKey(explicitlyRequestedAgent.agentId);
      const normalized = normalizeChatSendRequest({
        params: {
          sessionKey,
          message: initialMessage ?? "",
          mentions: p.mentions,
          idempotencyKey: initialRunId,
        },
        client,
      });
      if (!normalized.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, normalized.error));
        return;
      }
      const eligible = context.mentionInbox?.validateRecipients(
        client,
        {
          agentId: explicitlyRequestedAgent.agentId,
          ...(p.visibility ? { visibility: p.visibility } : {}),
        },
        p.mentions.map((mention) => mention.profileId),
      );
      if (!eligible?.ok) {
        respond(
          false,
          undefined,
          eligible?.error ??
            errorShape(
              ErrorCodes.UNAVAILABLE,
              "Human mentions are unavailable; reconnect and retry.",
            ),
        );
        return;
      }
    }
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
    const preparedDisplayName = normalizeOptionalString(p.displayName);
    const titleAgentId = explicitlyRequestedAgent.agentId;
    const existingTargetEntry = explicitlyRequestedKey
      ? loadGatewaySessionEntryReadOnly(explicitlyRequestedKey, { agentId: titleAgentId }).entry
      : undefined;
    if (existingTargetEntry?.repositoryWorkspaceId && !repository) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Repository sessions require their original repository source; dispatch the existing session to continue.",
        ),
      );
      return;
    }
    const deferWorktree = p.worktree === true && hasInitialTurn && !existingTargetEntry;
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
    let sessionAgentId = catalogAgentId ?? explicitlyRequestedAgent.agentId;
    if (repository) {
      sessionKey ??= buildDashboardSessionKey(sessionAgentId);
    }
    let preparedWorktree: PreparedGatewaySessionLifecycle | undefined;
    let pendingWorktree: InternalSessionEntry["pendingWorktree"];
    const sessionExecCwd = requestedExecNode ? requestedCwd : undefined;
    let sessionCwd = requestedExecNode ? undefined : (projectRoot ?? requestedCwd);
    let prepareLifecycle: Parameters<typeof createGatewaySession>[0]["prepareLifecycle"];
    const preparedRoot = repository
      ? undefined
      : prepareSessionCreateFilesystemRoot({
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
    if (preparedRoot && !preparedRoot.ok) {
      respond(false, undefined, preparedRoot.error);
      return;
    }
    sessionCwd = preparedRoot?.value.sessionCwd;
    const sessionRoot = preparedRoot?.value.sessionRoot;
    if (repository) {
      prepareLifecycle = prepareSessionRepositoryWorkspace(repository, {
        runSetupScript: clientScopes.includes(ADMIN_SCOPE),
        assertCurrent: commitGuard,
      });
    }
    if (p.worktree === true) {
      // Workspace-contained cwd and registry-authorized projects stay at operator.write;
      // arbitrary host paths still require operator.admin before reaching this block.
      const agentId = explicitlyRequestedAgent.agentId;
      let targetKey = sessionKey;
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
            !preparedDisplayName &&
            lifecycleTarget.entry &&
            lifecycleTarget.titleModelSelection !== null
              ? await generateWorktreeSessionTitle({
                  cfg,
                  agentId: lifecycleTarget.agentId,
                  // A new personal selection is not owned by this chat until
                  // creation commits; pre-commit naming uses its saved account.
                  entry:
                    requestedModel && !personalModelSelection
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
              preparedDisplayName ??
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
      displayName: preparedDisplayName,
      category: p.category,
      ...(catalogTarget ? { catalogTarget: catalogTarget.target } : { model: requestedModel }),
      personalModelSelection,
      personalAccountDefaults,
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
      armSessionDiffBaselineCapture: !repository,
      loadGatewayModelCatalog: () =>
        context.loadGatewayModelCatalog({ agentId: modelCatalogAgentId }),
      commitGuard,
      afterCreate: async ({ key, agentId }) => {
        if (!authority.hasActive() || !hasInitialTurn) {
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
            idempotencyKey: initialRunId,
            ...(p.mentions ? { mentions: p.mentions } : {}),
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
      },
    }).catch((error: unknown) => {
      if (error instanceof ModelAccountConnectAuthorityError) {
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
        return undefined;
      }
      return authority.handleClosedError(error);
    });
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
    const runStarted =
      !created.resetExisting &&
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
        ...(!created.resetExisting && runPayload ? runPayload : {}),
        ...(!created.resetExisting && runError ? { runError } : {}),
        resolved: created.resolved,
        ...(createdWorktree ? { worktree: createdWorktree } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: created.key,
      agentId: created.agentId,
      reason: created.resetExisting ? "new" : "create",
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
