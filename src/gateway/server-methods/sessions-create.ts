// Session creation, initial turns, and managed-worktree provisioning.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { err, ok as resultOk } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { slugifyWorktreeTitle } from "../../agents/worktrees/name.js";
import { managedWorktrees, WorktreeRepositoryError } from "../../agents/worktrees/service.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { buildDashboardSessionTitleSource } from "../dashboard-session-title.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { buildDashboardSessionKey, createGatewaySession } from "../session-create-service.js";
import type { PrepareGatewaySessionLifecycle } from "../session-lifecycle-preparation.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { readSessionMessageCountAsync } from "../session-transcript-readers.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { chatHandlers } from "./chat.js";
import { resolveRegisteredCatalogCreateTarget } from "./session-catalog.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { captureCreatedSessionDiffBaseline } from "./session-create-diff-baseline.js";
import {
  resolveSessionCreateInitialTurn,
  shouldAttachPendingMessageSeq,
} from "./session-create-initial-turn.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

export const sessionCreateHandlers: GatewayRequestHandlers = {
  "sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond);
    const catalogId = normalizeOptionalString(p.catalogId);
    if (catalogId && p.model) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create catalogId cannot include model"),
      );
      return;
    }
    if (catalogId && p.key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create catalogId cannot include key"),
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
      explicitlyRequestedAgentId,
      { allowUnconfiguredExplicitAgent: true },
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
    if (requestedProjectId && (requestedCwd || requestedExecNode)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create projectId cannot be combined with cwd or execNode",
        ),
      );
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
        const checkout = await resolveProjectCheckout(project.repoRoot);
        if (project.source !== "workspace" && checkout.path !== checkout.repoRoot) {
          throw new ProjectCheckoutError(`project root is no longer a git checkout`);
        }
        projectRoot = checkout.path;
      } catch (error) {
        const detail =
          error instanceof ProjectCheckoutError ? error.message : formatErrorMessage(error);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `project ${requestedProjectId} is unavailable (${detail}); re-register it or run openclaw doctor --fix`,
          ),
        );
        return;
      }
    }
    let sessionKey = p.key;
    let sessionAgentId =
      catalogAgentId ??
      explicitlyRequestedAgent.agentId ??
      p.agentId ??
      parseAgentSessionKey(explicitlyRequestedKey)?.agentId;
    let sessionWorktree: Awaited<ReturnType<typeof managedWorktrees.create>> | undefined;
    const sessionExecCwd = requestedExecNode ? requestedCwd : undefined;
    let sessionCwd = requestedExecNode ? undefined : (projectRoot ?? requestedCwd);
    let prepareLifecycle: PrepareGatewaySessionLifecycle | undefined;
    if (sessionCwd && !requestedExecNode && (requestedProjectId || p.worktree !== true)) {
      const targetAgentId = normalizeAgentId(
        sessionAgentId ??
          parseAgentSessionKey(sessionKey ?? "")?.agentId ??
          explicitlyRequestedAgent.agentId,
      );
      const targetSessionKey = sessionKey ?? `agent:${targetAgentId}:dashboard:pending`;
      const targetRuntime = resolveSandboxRuntimeStatus({
        cfg,
        agentId: targetAgentId,
        sessionKey: targetSessionKey,
      });
      // Sandboxed dashboard sessions mount only their configured agent workspace.
      if (
        targetRuntime.sandboxed &&
        !isPathInside(
          resolveUserPath(resolveAgentWorkspaceDir(cfg, targetAgentId)),
          resolveUserPath(sessionCwd),
        )
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            requestedProjectId
              ? "sessions.create project is outside the sandboxed agent workspace"
              : "sessions.create cwd is outside the sandboxed agent workspace",
          ),
        );
        return;
      }
    }
    if (p.worktree === true) {
      // Workspace-contained cwd and registry-authorized projects stay at operator.write;
      // arbitrary host paths still require operator.admin before reaching this block.
      const explicitKey = explicitlyRequestedKey;
      const agentId = normalizeAgentId(
        explicitlyRequestedAgent.agentId ??
          normalizeOptionalString(p.agentId) ??
          parseAgentSessionKey(explicitKey)?.agentId,
      );
      let targetKey = explicitKey;
      let preservesUnspecifiedKey = false;
      const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
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
        const parentAgentId = normalizeAgentId(
          parentRequestedAgent.agentId ?? resolveSessionStoreAgentId(cfg, parent.canonicalKey),
        );
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
      const workspace =
        projectRoot ?? requestedCwd ?? resolveAgentWorkspaceDir(cfg, target.agentId);
      // Subdirectory workspaces are valid: the worktree service resolves the repo root
      // via git discovery, so the preflight must accept ancestor .git entries too.
      if (!insideGitCheckout(workspace)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
        );
        return;
      }
      let requestedRepository: Awaited<ReturnType<typeof managedWorktrees.resolveRepositoryPaths>>;
      try {
        requestedRepository = await managedWorktrees.resolveRepositoryPaths(workspace);
      } catch (error) {
        if (error instanceof WorktreeRepositoryError) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
          );
          return;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        return;
      }

      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      prepareLifecycle = async (lifecycleTarget) => {
        try {
          const boundId = normalizeOptionalString(lifecycleTarget.entry?.worktree?.id);
          let existing = boundId ? managedWorktrees.findLiveById(boundId) : undefined;
          if (
            existing &&
            (existing.ownerKind !== "session" || existing.ownerId !== lifecycleTarget.key)
          ) {
            return err(
              errorShape(ErrorCodes.UNAVAILABLE, "session worktree binding has a different owner"),
            );
          }
          existing ??= managedWorktrees.findLiveByOwner("session", lifecycleTarget.key);
          let existingDirectory = false;
          if (existing) {
            try {
              existingDirectory = fs.lstatSync(existing.path).isDirectory();
            } catch {
              // Missing registry targets are replaced by create() under its owner lease.
            }
          }
          let provisioned = false;
          if (existing && existingDirectory) {
            if (existing.repoRoot !== requestedRepository.canonicalRoot) {
              return err(
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  "session worktree belongs to a different repository",
                ),
              );
            }
            if (
              (requestedWorktreeName && existing.name !== requestedWorktreeName) ||
              requestedWorktreeBaseRef
            ) {
              return err(
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `session is already bound to worktree ${existing.name} (${existing.branch})`,
                ),
              );
            }
            sessionWorktree = existing;
          } else {
            sessionWorktree = await managedWorktrees.create({
              repoRoot: workspace,
              ownerKind: "session",
              ownerId: lifecycleTarget.key,
              name: requestedWorktreeName,
              suggestedName: slugifyWorktreeTitle(
                normalizeOptionalString(p.label) ??
                  buildDashboardSessionTitleSource({
                    message: initialMessage ?? "",
                    attachments: initialAttachments,
                  }),
              ),
              baseRef: requestedWorktreeBaseRef,
              // Checkout hooks and .openclaw/worktree-setup.sh run repo code; keep them
              // admin-only so this write-scoped path cannot execute gated repo scripts.
              runSetupScript: scopes.includes(ADMIN_SCOPE),
              ...(authority.commitGuard ? { commitGuard: authority.commitGuard } : {}),
            });
            provisioned = true;
          }
          // Nested workspaces run from the matching subdirectory inside the worktree.
          sessionCwd = sessionWorktree.path;
          try {
            const relative = path.relative(
              requestedRepository.sourceRoot,
              fs.realpathSync(workspace),
            );
            if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
              sessionCwd = path.join(sessionWorktree.path, relative);
              fs.mkdirSync(sessionCwd, { recursive: true });
            }
          } catch {
            sessionCwd = sessionWorktree.path;
          }
          const preparedWorktree = sessionWorktree;
          return resultOk({
            spawnedCwd: sessionCwd,
            worktree: {
              id: preparedWorktree.id,
              branch: preparedWorktree.branch,
              repoRoot: preparedWorktree.repoRoot,
            },
            ...(provisioned
              ? {
                  rollback: async () => {
                    await managedWorktrees.remove({
                      id: preparedWorktree.id,
                      reason: "session-create-failed",
                      force: true,
                    });
                  },
                }
              : {}),
          });
        } catch (error) {
          if (error instanceof TypeError && !authority.hasActive()) {
            throw error;
          }
          if (error instanceof WorktreeRepositoryError) {
            return err(
              errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
            );
          }
          return err(errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      };
    }
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    let messageSeq: number | undefined;
    const sessionCreation = resolveOperatorSessionCreation(client, { allowTrustedHint: true });
    const spawnActorSessionKey =
      sessionCreation.via === "spawn" && sessionCreation.actor?.type === "agent"
        ? normalizeOptionalString(sessionCreation.actor.id)
        : undefined;
    if (
      sessionCreation.inheritedToolPolicy &&
      spawnActorSessionKey &&
      normalizeOptionalString(p.parentSessionKey) !== spawnActorSessionKey
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spawn parent must match the trusted agent caller"),
      );
      return;
    }
    const allowExistingModelSelection = authorizeOperatorScopesForRequiredScope(
      ADMIN_SCOPE,
      clientScopes,
    ).allowed;
    const modelCatalogAgentId = normalizeAgentId(
      sessionAgentId ??
        parseAgentSessionKey(sessionKey ?? "")?.agentId ??
        explicitlyRequestedAgent.agentId,
    );
    if (!authority.ensureActive()) {
      return;
    }
    const created = await createGatewaySession({
      cfg,
      key: sessionKey,
      agentId: sessionAgentId,
      label: p.label,
      ...(catalogTarget ? { catalogTarget: catalogTarget.target } : { model: p.model }),
      thinkingLevel: p.thinkingLevel,
      projectId: requestedProjectId,
      incognito: p.incognito,
      ...(client?.connect ? { requestingOperatorScopes: clientScopes } : {}),
      visibility: p.visibility,
      allowExistingModelSelection,
      parentSessionKey: p.parentSessionKey,
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
      succeedsParent: p.succeedsParent,
      emitCommandHooks: p.emitCommandHooks,
      resetMainWhenUnspecified: !hasInitialTurn,
      commandSource: "webchat",
      creation: sessionCreation,
      authorizedPluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
      loadGatewayModelCatalog: () =>
        context.loadGatewayModelCatalog({ agentId: modelCatalogAgentId }),
      ...(authority.commitGuard ? { commitGuard: authority.commitGuard } : {}),
      afterCreate: async ({ key, agentId, entry, storePath }) => {
        // Session persistence already committed under the guard. Closure after
        // that point may suppress follow-on work, but cannot roll back the session.
        if (!authority.hasActive()) {
          return;
        }
        await captureCreatedSessionDiffBaseline({ key, agentId, cfg, entry, storePath });
        if (hasInitialTurn) {
          if (!authority.hasActive()) {
            return;
          }
          messageSeq =
            (await readSessionMessageCountAsync({
              agentId,
              sessionEntry: entry,
              sessionId: entry.sessionId,
              sessionKey: key,
              storePath,
            })) + 1;
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
    if (created.resetExisting) {
      await captureCreatedSessionDiffBaseline({
        key: created.key,
        agentId: created.agentId,
        cfg,
        entry: created.entry,
        storePath: resolveGatewaySessionStoreTarget({
          cfg,
          key: created.key,
          agentId: created.agentId,
        }).storePath,
      });
    }
    const createdWorktree = sessionWorktree
      ? {
          id: sessionWorktree.id,
          path: sessionWorktree.path,
          branch: sessionWorktree.branch,
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
      shouldAttachPendingMessageSeq({
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
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
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
