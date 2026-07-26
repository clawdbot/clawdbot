// Session creation, initial turns, and managed-worktree provisioning.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import {
  buildDashboardSessionKey,
  createGatewaySession,
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
} from "../session-create-service.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { readSessionMessageCountAsync } from "../session-transcript-readers.js";
import { loadSessionEntryReadOnly, resolveGatewaySessionStoreTarget } from "../session-utils.js";
import { chatHandlers } from "./chat.js";
import { resolveSessionCatalogCreateTarget } from "./session-catalog.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  resolveSessionCreateInitialTurn,
  shouldAttachPendingMessageSeq,
} from "./session-create-initial-turn.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionCreateHandlers: GatewayRequestHandlers = {
  "sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
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
    const catalogRequestedKey = normalizeOptionalString(p.key) ?? "global";
    const catalogAgentId = catalogId
      ? normalizeAgentId(
          normalizeOptionalString(p.agentId) ??
            parseAgentSessionKey(catalogRequestedKey)?.agentId ??
            resolveDefaultAgentId(cfg),
        )
      : undefined;
    const catalogRequestedAgent = catalogAgentId
      ? resolveRequestedGlobalAgentId(cfg, catalogRequestedKey, catalogAgentId)
      : undefined;
    if (catalogRequestedAgent && !catalogRequestedAgent.ok) {
      respond(false, undefined, catalogRequestedAgent.error);
      return;
    }
    const catalogTarget =
      catalogId && catalogAgentId
        ? resolveSessionCatalogCreateTarget(catalogId, catalogAgentId)
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
    const requestedCwd = normalizeOptionalString(p.cwd);
    const requestedExecNode = normalizeOptionalString(p.execNode);
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
    let sessionKey = p.key;
    let sessionAgentId = catalogAgentId ?? p.agentId;
    let sessionWorktree: Awaited<ReturnType<typeof managedWorktrees.create>> | undefined;
    const sessionExecCwd = requestedExecNode ? requestedCwd : undefined;
    let sessionCwd = requestedExecNode ? undefined : requestedCwd;
    let sessionSourceRoot: string | undefined;
    let provisionedSessionWorktree = false;
    if (requestedCwd && !requestedExecNode && p.worktree !== true) {
      const targetAgentId = normalizeAgentId(
        sessionAgentId ??
          parseAgentSessionKey(sessionKey ?? "")?.agentId ??
          resolveDefaultAgentId(cfg),
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
          resolveUserPath(requestedCwd),
        )
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "sessions.create cwd is outside the sandboxed agent workspace",
          ),
        );
        return;
      }
    }
    if (p.worktree === true) {
      // The normal path stays at operator.write and checks out the configured agent workspace.
      // An explicit cwd can target another host checkout, so method-scopes requires admin.
      const explicitKey = normalizeOptionalString(p.key);
      const requestedKey = explicitKey ?? "global";
      const requestedAgent = resolveRequestedGlobalAgentId(cfg, requestedKey, p.agentId);
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      const agentId = normalizeAgentId(
        requestedAgent.agentId ??
          normalizeOptionalString(p.agentId) ??
          parseAgentSessionKey(requestedKey)?.agentId ??
          resolveDefaultAgentId(cfg),
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
        const parent = loadSessionEntryReadOnly(
          parentSessionKey,
          requestedAgent.agentId ? { agentId: requestedAgent.agentId } : undefined,
        );
        const parentAgentId = normalizeAgentId(
          requestedAgent.agentId ?? resolveSessionStoreAgentId(cfg, parent.canonicalKey),
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
      const workspace = requestedCwd ?? resolveAgentWorkspaceDir(cfg, target.agentId);
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
      try {
        const requestedRepository = await managedWorktrees.resolveRepositoryPaths(workspace);
        sessionSourceRoot = requestedRepository.sourceRoot;
        const existing = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
        let existingDirectory = false;
        if (existing) {
          try {
            existingDirectory = fs.lstatSync(existing.path).isDirectory();
          } catch {
            // Missing registry targets are replaced; periodic GC retires their stale rows.
          }
        }
        if (existing && existingDirectory) {
          if (existing.repoRoot !== requestedRepository.canonicalRoot) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "session worktree belongs to a different repository",
              ),
            );
            return;
          }
          // Adopting an existing checkout cannot honor a different name or a
          // new base; fail loudly instead of silently ignoring the request.
          if (
            (requestedWorktreeName && existing.name !== requestedWorktreeName) ||
            requestedWorktreeBaseRef
          ) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `session is already bound to worktree ${existing.name} (${existing.branch})`,
              ),
            );
            return;
          }
          sessionWorktree = existing;
        } else {
          const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
          sessionWorktree = await managedWorktrees.create({
            repoRoot: workspace,
            ownerKind: "session",
            ownerId: target.canonicalKey,
            name: requestedWorktreeName,
            baseRef: requestedWorktreeBaseRef,
            // Checkout hooks and .openclaw/worktree-setup.sh run repo code; keep them
            // admin-only so this write-scoped path cannot execute gated repo scripts.
            runSetupScript: scopes.includes(ADMIN_SCOPE),
          });
          provisionedSessionWorktree = true;
        }
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        return;
      }
      // Nested workspaces run from the matching subdirectory inside the worktree, mirroring
      // how the session would have run in the source checkout; the worktree root would
      // silently change tool/file scope for subdirectory-configured agents.
      sessionCwd = sessionWorktree.path;
      try {
        const relative = path.relative(
          sessionSourceRoot ?? fs.realpathSync(sessionWorktree.repoRoot),
          fs.realpathSync(workspace),
        );
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          sessionCwd = path.join(sessionWorktree.path, relative);
          fs.mkdirSync(sessionCwd, { recursive: true });
        }
      } catch {
        sessionCwd = sessionWorktree.path;
      }
    }
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    let messageSeq: number | undefined;
    const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const allowExistingModelSelection = authorizeOperatorScopesForRequiredScope(
      ADMIN_SCOPE,
      clientScopes,
    ).allowed;
    const created = await createGatewaySession({
      cfg,
      key: sessionKey,
      agentId: sessionAgentId,
      label: p.label,
      ...(catalogTarget ? { catalogTarget: catalogTarget.target } : { model: p.model }),
      thinkingLevel: p.thinkingLevel,
      incognito: p.incognito,
      ...(client?.connect ? { requestingOperatorScopes: clientScopes } : {}),
      visibility: p.visibility,
      allowExistingModelSelection,
      parentSessionKey: p.parentSessionKey,
      spawnDepth: p.spawnDepth,
      spawnedCwd: sessionCwd,
      worktree: sessionWorktree
        ? {
            id: sessionWorktree.id,
            branch: sessionWorktree.branch,
            repoRoot: sessionWorktree.repoRoot,
          }
        : undefined,
      execNode: requestedExecNode,
      execCwd: sessionExecCwd,
      clearExecBinding: !requestedExecNode,
      // A plain New Chat with no cwd must not inherit the prior session cwd.
      clearSpawnedCwd: !sessionCwd,
      fork: p.fork,
      succeedsParent: p.succeedsParent,
      emitCommandHooks: p.emitCommandHooks,
      resetMainWhenUnspecified: !hasInitialTurn,
      commandSource: "webchat",
      creation: resolveOperatorSessionCreation(client, { allowTrustedHint: true }),
      loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      afterCreate: hasInitialTurn
        ? async ({ key, agentId, entry, storePath }) => {
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
                ...(key === "global" ? { agentId } : {}),
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
        : undefined,
    });
    if (!created.ok) {
      if (sessionWorktree && provisionedSessionWorktree) {
        try {
          await managedWorktrees.remove({
            id: sessionWorktree.id,
            reason: "session-create-failed",
            force: true,
          });
        } catch (error) {
          sessionLog.warn(
            `failed to clean up worktree after session creation failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      respond(false, undefined, created.error);
      return;
    }
    // Leaving an isolated checkout via a plain New Chat detaches the session from its
    // worktree; remove it when lossless so the reset does not orphan a protected worktree.
    if (p.worktree !== true) {
      try {
        const owned = managedWorktrees.findLiveByOwner("session", created.key);
        if (owned) {
          await managedWorktrees.removeIfLossless(owned.id);
        }
      } catch (error) {
        sessionLog.warn(
          `failed to release worktree for reset session ${created.key}: ${formatErrorMessage(error)}`,
        );
      }
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
        ...(created.key === "global" ? { agentId: created.agentId } : {}),
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
      ...(created.key === "global" ? { agentId: created.agentId } : {}),
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: created.key,
        ...(created.key === "global" ? { agentId: created.agentId } : {}),
        reason: "send",
      });
    }
  },
};
