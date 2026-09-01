import {
  type BoardSnapshot,
  type BoardWidgetMaterializedPutParams,
  validateBoardActionParams,
  validateBoardDataReadParams,
  validateBoardEventParams,
  validateBoardGetParams,
  validateBoardPromptAuthorizeParams,
  validateBoardUpdateParams,
  validateBoardWidgetContent,
  validateBoardWidgetAppViewParams,
  validateBoardWidgetGrantParams,
  validateBoardWidgetPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import {
  boardWidgetHasGrantedTool,
  normalizeBoardWidgetDeclared,
} from "../../boards/board-capabilities.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import { appendBoardEventNotice } from "../../boards/board-notices.js";
import type { BoardSessionTarget, BoardStore } from "../../boards/board-store.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import { buildWidgetDocument } from "../../canvas/wrap.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadExecApprovalsReadOnly } from "../../infra/exec-approvals.js";
import { resolveExecAutoReviewDecision } from "../../infra/exec-auto-review.js";
import {
  resolveBoardWidgetContentKind,
  resolveBoardWidgetContentKindByPluginKind,
  resolveBoardWidgetContentKindResourceUrls,
} from "../../plugins/board-widget-content-kinds.js";
import {
  captureBoardRequestAuthority,
  readBoardDataBinding,
  respondBoardError,
  runBoardActionVerb,
  triggerBoardCronJob,
} from "../board-host-tools.js";
import { buildBoardWidgetSandboxPath } from "../board-sandbox.js";
import { boardStore } from "../board-store.js";
import {
  BOARD_VIEW_TICKET_TTL_MS,
  buildBoardWidgetFrameUrl,
  createBoardViewTicket,
} from "../board-view-ticket.js";
import { resolveAuthorizedBoardWidgetView } from "../board-widget-view.js";
import {
  requireMcpAppInteraction,
  resolveMcpAppActiveView,
  resolveMcpAppAllowedToolNames,
} from "../mcp-app-operations.js";
import { mintMcpAppViewFromTranscript } from "../mcp-app-reconstruction.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayMethod } from "./validation.js";

type NoticeAppender = typeof appendBoardEventNotice;
type CanvasDocumentReader = typeof readCanvasDocumentHtmlSource;
type McpAppDependencies = {
  resolveActiveView: typeof resolveMcpAppActiveView;
  resolveAllowedToolNames: typeof resolveMcpAppAllowedToolNames;
  mintFromTranscript: typeof mintMcpAppViewFromTranscript;
};
type BoardDataReader = typeof readBoardDataBinding;
type BoardActionVerbRunner = typeof runBoardActionVerb;
type BoardCronTrigger = typeof triggerBoardCronJob;
type BoardHandlerDependencies = Partial<McpAppDependencies> & {
  readDataBinding?: BoardDataReader;
  runActionVerb?: BoardActionVerbRunner;
  triggerCronJob?: BoardCronTrigger;
};

const defaultMcpAppDependencies: McpAppDependencies = {
  resolveActiveView: resolveMcpAppActiveView,
  resolveAllowedToolNames: resolveMcpAppAllowedToolNames,
  mintFromTranscript: mintMcpAppViewFromTranscript,
};

function resolveBoardSession(
  params: { sessionKey: string; agentId?: string | undefined },
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): Required<BoardSessionTarget> | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  const canonicalKey = resolveSessionStoreKey({
    cfg,
    sessionKey: params.sessionKey,
    storeAgentId: requested.agentId,
  });
  return { sessionKey: canonicalKey, agentId: requested.agentId };
}

function projectBoardSnapshot<T extends BoardSnapshot>(snapshot: T, agentId: string): T {
  // Observer identities distinguish global boards on the wire, never in stored rows.
  return { ...snapshot, sessionKey: sessionObserverScopeKey(snapshot.sessionKey, agentId) };
}

function assertCapabilityParamsSize(
  params: Record<string, unknown>,
  capability: "action" | "data binding",
): void {
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > 8 * 1024) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget ${capability} params exceed 8192 UTF-8 bytes`,
    );
  }
}

async function resolveBoardWidgetApproval(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  name: string;
  declared: NonNullable<BoardWidgetMaterializedPutParams["declared"]>;
}): Promise<"granted" | "rejected" | undefined> {
  const { cfg, agentId, sessionKey, name, declared } = params;
  const mode = resolveExecDefaults({
    cfg,
    agentId,
    sessionKey,
    sessionEntry: loadSessionEntryReadOnly({ sessionKey, agentId }),
    execApprovals: loadExecApprovalsReadOnly(),
  }).mode;
  if (mode === "ask") {
    return undefined;
  }
  if (mode !== "auto") {
    return mode === "full" ? "granted" : "rejected";
  }
  const { createModelExecAutoReviewer } = await import("../../agents/exec-auto-reviewer.js");
  const review = await resolveExecAutoReviewDecision(
    createModelExecAutoReviewer({
      cfg,
      agentId,
      reviewer:
        resolveAgentConfig(cfg, agentId)?.tools?.exec?.reviewer ?? cfg.tools?.exec?.reviewer,
    }),
    { kind: "board-widget", name, declared, agent: { id: agentId, sessionKey } },
  );
  return review.decision === "allow-once" && review.risk === "low" ? "granted" : "rejected";
}

export function createBoardHandlers(
  store: BoardStore,
  appendNotice: NoticeAppender = appendBoardEventNotice,
  readCanvasDocument: CanvasDocumentReader = readCanvasDocumentHtmlSource,
  dependencies: BoardHandlerDependencies = {},
): GatewayRequestHandlers {
  const mcpApp: McpAppDependencies = {
    resolveActiveView:
      dependencies.resolveActiveView ?? defaultMcpAppDependencies.resolveActiveView,
    resolveAllowedToolNames:
      dependencies.resolveAllowedToolNames ?? defaultMcpAppDependencies.resolveAllowedToolNames,
    mintFromTranscript:
      dependencies.mintFromTranscript ?? defaultMcpAppDependencies.mintFromTranscript,
  };
  const readDataBinding = dependencies.readDataBinding ?? readBoardDataBinding;
  const runActionVerb = dependencies.runActionVerb ?? runBoardActionVerb;
  const triggerCronJob = dependencies.triggerCronJob ?? triggerBoardCronJob;
  return {
    "board.get": defineValidatedGatewayMethod(
      "board.get",
      validateBoardGetParams,
      async (invocation) => {
        const { params: boardParams, respond, context, client } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          const { snapshot, htmlViewMetadata } =
            store.getSnapshotWithHtmlViewMetadata(boardSession);
          let sandboxPort = context.getMcpAppSandboxPort?.();
          let sandboxOrigin: string | undefined;
          let sandboxOriginResolved = false;
          for (const widget of snapshot.widgets) {
            if (widget.grantState !== "none" && widget.grantState !== "granted") {
              continue;
            }
            const viewMetadata = htmlViewMetadata.get(widget.name);
            if (!viewMetadata || viewMetadata.revision !== widget.revision) {
              continue;
            }
            const registration = widget.pluginKind
              ? resolveBoardWidgetContentKindByPluginKind(
                  authority.pluginRegistry,
                  widget.pluginKind,
                )
              : undefined;
            const scopedHostUrl = registration
              ? client?.pluginSurfaceUrls?.[registration.definition.resources.surface]
              : undefined;
            const resourceUrls =
              registration && scopedHostUrl
                ? resolveBoardWidgetContentKindResourceUrls(registration, scopedHostUrl)
                : undefined;
            if (
              widget.contentKind === "plugin" &&
              (!registration || !resourceUrls || !scopedHostUrl)
            ) {
              continue;
            }
            const resourceOrigins = resourceUrls
              ? [...new Set(Object.values(resourceUrls).map((url) => new URL(url).origin))]
              : undefined;
            if (sandboxPort === undefined && context.ensureSandboxHostPort) {
              sandboxPort = await context.ensureSandboxHostPort();
              authority.assertActive();
            }
            authority.assertActive();
            const { ticket } = createBoardViewTicket({
              agentId: boardSession.agentId,
              sessionKey: snapshot.sessionKey,
              name: widget.name,
              revision: widget.revision,
              viewGeneration: viewMetadata.viewGeneration,
              ...(registration && scopedHostUrl
                ? {
                    pluginFrame: {
                      pluginKind: registration.pluginKind,
                      scopedHostUrl,
                    },
                  }
                : {}),
              authority: authority.ticketAuthority,
            });
            if (registration) {
              widget.kindLabel = registration.definition.label;
            }
            widget.frameUrl = buildBoardWidgetFrameUrl({
              sessionKey: sessionObserverScopeKey(snapshot.sessionKey, boardSession.agentId),
              name: widget.name,
              ticket,
            });
            widget.viewTicket = ticket;
            widget.viewTicketTtlMs = BOARD_VIEW_TICKET_TTL_MS;
            widget.viewGeneration = viewMetadata.viewGeneration;
            if (sandboxPort !== undefined) {
              widget.sandboxUrl = buildBoardWidgetSandboxPath({
                ...viewMetadata,
                ...(resourceOrigins ? { resourceOrigins } : {}),
              });
              widget.sandboxPort = sandboxPort;
              if (!sandboxOriginResolved) {
                const configuredOrigin = context.getRuntimeConfig?.().mcp?.apps?.sandboxOrigin;
                sandboxOrigin = configuredOrigin ? new URL(configuredOrigin).origin : undefined;
                sandboxOriginResolved = true;
              }
              if (sandboxOrigin) {
                widget.sandboxOrigin = sandboxOrigin;
              }
            }
          }
          authority.assertActive();
          respond(true, projectBoardSnapshot(snapshot, boardSession.agentId));
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.update": defineValidatedGatewayMethod(
      "board.update",
      validateBoardUpdateParams,
      (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          authority.assertActive();
          const snapshot = projectBoardSnapshot(
            store.applyOps(boardSession, boardParams.ops),
            boardSession.agentId,
          );
          if (boardParams.ops.length > 0) {
            context.broadcast("board.changed", {
              sessionKey: snapshot.sessionKey,
              revision: snapshot.revision,
            });
          }
          respond(true, snapshot);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.widget.put": defineValidatedGatewayMethod(
      "board.widget.put",
      validateBoardWidgetPutParams,
      async (invocation) => {
        const { params: requestParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(requestParams, context, respond);
          if (!boardSession) {
            return;
          }
          const { declared: requestDeclared, ...requestWithoutDeclared } = requestParams;
          let content: BoardWidgetMaterializedPutParams["content"];
          let declared = requestDeclared;
          if (requestParams.content.kind === "canvas-doc") {
            const document = await readCanvasDocument(requestParams.content.docId);
            authority.assertActive();
            if (document.cspSandbox !== "scripts") {
              throw new BoardValidationError(
                "invalid_operation",
                `canvas document is not script-enabled: ${requestParams.content.docId}`,
              );
            }
            content = { kind: "html", html: document.html };
          } else if (requestParams.content.kind === "mcp-app") {
            const active = await mcpApp.resolveActiveView({
              ...boardSession,
              viewId: requestParams.content.viewId,
              cfg: context.getRuntimeConfig(),
            });
            authority.assertActive();
            const { view } = active;
            if (!view.toolCallId) {
              throw new BoardValidationError(
                "invalid_operation",
                "MCP App view is missing its originating tool call",
              );
            }
            let interactive = false;
            try {
              await requireMcpAppInteraction(view);
              interactive = true;
            } catch {
              // Reconstructed or revoked source leases may be pinned only as read-only content.
            }
            authority.assertActive();
            const allowedTools = interactive ? await mcpApp.resolveAllowedToolNames(active) : [];
            authority.assertActive();
            if (interactive) {
              try {
                await requireMcpAppInteraction(view);
              } catch {
                interactive = false;
              }
              authority.assertActive();
            }
            content = {
              kind: "mcp-app",
              descriptor: {
                serverName: view.serverName,
                toolName: view.toolName,
                uiResourceUri: view.uiResourceUri,
                toolCallId: view.toolCallId,
              },
              interactive,
            };
            declared = interactive && allowedTools.length > 0 ? { tools: allowedTools } : undefined;
          } else if (requestParams.content.kind === "registered") {
            const registration = resolveBoardWidgetContentKind(
              authority.pluginRegistry,
              requestParams.content.contentKind,
            );
            if (!registration) {
              throw new BoardValidationError(
                "invalid_operation",
                `widget kind ${JSON.stringify(requestParams.content.contentKind)} is unavailable; enable the plugin that provides it and retry`,
              );
            }
            try {
              registration.definition.validateSource(requestParams.content.source);
            } catch (error) {
              throw new BoardValidationError(
                "invalid_operation",
                `invalid ${requestParams.content.contentKind} widget source: ${String(error)}`,
              );
            }
            content = {
              ...requestParams.content,
              pluginKind: registration.pluginKind,
            };
          } else {
            content = requestParams.content;
          }
          const persistedContent =
            content.kind === "mcp-app"
              ? { kind: content.kind, descriptor: content.descriptor }
              : content.kind === "registered"
                ? {
                    kind: content.kind,
                    contentKind: content.contentKind,
                    source: content.source,
                  }
                : content;
          if (
            !assertValidParams(
              persistedContent,
              validateBoardWidgetContent,
              "board.widget.put content",
              respond,
            )
          ) {
            return;
          }
          declared = normalizeBoardWidgetDeclared(declared);
          const materializedContent: BoardWidgetMaterializedPutParams["content"] =
            content.kind === "html"
              ? {
                  kind: "html",
                  // Authority-bearing bridge code must precede every admitted
                  // byte, including complete HTML and managed Canvas documents.
                  // The wrapper is idempotent so an already-wrapped Canvas view
                  // keeps one effective bridge owner.
                  html: buildWidgetDocument(
                    requestParams.title ?? requestParams.name,
                    content.html,
                    {
                      connectOrigins: declared?.netOrigins,
                    },
                  ),
                }
              : content;
          const boardParams: BoardWidgetMaterializedPutParams = {
            ...requestWithoutDeclared,
            ...boardSession,
            content: materializedContent,
            ...(declared ? { declared } : {}),
          };
          authority.assertActive();
          let snapshot = store.putWidget(boardParams);
          const widget = snapshot.widgets.find(
            (candidate) => candidate.name === snapshot.resolvedWidgetName,
          );
          if (widget?.grantState === "pending") {
            const decision = await resolveBoardWidgetApproval({
              cfg: context.getRuntimeConfig(),
              ...boardSession,
              name: snapshot.resolvedWidgetName,
              declared: declared ?? {},
            });
            authority.assertActive();
            if (decision) {
              snapshot = {
                ...store.grant(
                  boardSession,
                  snapshot.resolvedWidgetName,
                  decision,
                  widget.revision,
                  widget.instanceId,
                ),
                resolvedWidgetName: snapshot.resolvedWidgetName,
              };
            }
          }
          snapshot = projectBoardSnapshot(snapshot, boardSession.agentId);
          context.broadcast("board.changed", {
            sessionKey: snapshot.sessionKey,
            revision: snapshot.revision,
            widget: snapshot.resolvedWidgetName,
          });
          respond(true, snapshot);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.widget.grant": defineValidatedGatewayMethod(
      "board.widget.grant",
      validateBoardWidgetGrantParams,
      (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          authority.assertActive();
          const snapshot = projectBoardSnapshot(
            store.grant(
              boardSession,
              boardParams.name,
              boardParams.decision,
              boardParams.revision,
              boardParams.instanceId,
            ),
            boardSession.agentId,
          );
          context.broadcast("board.changed", {
            sessionKey: snapshot.sessionKey,
            revision: snapshot.revision,
          });
          respond(true, snapshot);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.widget.appView": defineValidatedGatewayMethod(
      "board.widget.appView",
      validateBoardWidgetAppViewParams,
      async ({ params: boardParams, respond, context }) => {
        try {
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          const snapshot = store.getSnapshot(boardSession);
          const widget = snapshot.widgets.find((candidate) => candidate.name === boardParams.name);
          const document = store.readWidgetMcpApp(boardSession, boardParams.name);
          if (
            !widget ||
            widget.contentKind !== "mcp-app" ||
            widget.revision !== boardParams.revision ||
            widget.instanceId !== boardParams.instanceId ||
            !document ||
            document.revision !== boardParams.revision ||
            document.instanceId !== boardParams.instanceId
          ) {
            throw new BoardValidationError(
              "not_found",
              `board MCP App widget not found: ${boardParams.name}`,
            );
          }
          const interactive = document.interactive && document.grantState === "granted";
          const authorizeAppInteraction = interactive
            ? () => {
                const current = store.readWidgetMcpApp(boardSession, boardParams.name);
                return (
                  current?.interactive === true &&
                  current.grantState === "granted" &&
                  current.revision === boardParams.revision &&
                  current.instanceId === boardParams.instanceId
                );
              }
            : undefined;
          const minted = await mcpApp.mintFromTranscript({
            cfg: context.getRuntimeConfig(),
            ...boardSession,
            descriptor: document.descriptor,
            allowedAppToolNames: new Set(interactive ? document.declaredTools : []),
            ...(authorizeAppInteraction ? { authorizeAppInteraction } : {}),
            readOnly: !interactive,
          });
          if (!minted) {
            throw new Error("Pinned MCP App source is no longer available");
          }
          respond(true, {
            viewId: minted.view.viewId,
            expiresAtMs: minted.view.expiresAtMs,
          });
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.event": defineValidatedGatewayMethod(
      "board.event",
      validateBoardEventParams,
      (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const identity =
            "ticket" in boardParams
              ? resolveAuthorizedBoardWidgetView(store, boardParams.ticket, {
                  gatewayContext: context,
                })
              : (() => {
                  const boardSession = resolveBoardSession(boardParams, context, respond);
                  if (!boardSession) {
                    return undefined;
                  }
                  const snapshot = store.getSnapshot(boardSession);
                  const widget = snapshot.widgets.some(
                    (candidate) => candidate.name === boardParams.widget,
                  );
                  if (!widget) {
                    throw new BoardValidationError(
                      "not_found",
                      `board widget not found: ${boardParams.widget}`,
                    );
                  }
                  return { ...boardSession, name: boardParams.widget };
                })();
          if (!identity) {
            return;
          }
          authority.assertActive();
          const appended = appendNotice({
            sessionKey: identity.sessionKey,
            agentId: identity.agentId,
            widget: identity.name,
            payload: boardParams.payload,
          });
          respond(true, { ok: true, appended });
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.prompt.authorize": defineValidatedGatewayMethod(
      "board.prompt.authorize",
      validateBoardPromptAuthorizeParams,
      (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket, {
            gatewayContext: context,
          });
          authority.assertActive();
          respond(true, {
            confirmationRequired: !boardWidgetHasGrantedTool(
              document.declared,
              document.grantState,
              "prompt",
            ),
          });
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.data.read": defineValidatedGatewayMethod(
      "board.data.read",
      validateBoardDataReadParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const bindingParams = boardParams.params ?? {};
          assertCapabilityParamsSize(bindingParams, "data binding");
          const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket, {
            gatewayContext: context,
          });
          if (
            !boardWidgetHasGrantedTool(
              document.declared,
              document.grantState,
              boardParams.bindingId,
            )
          ) {
            throw new BoardValidationError(
              "invalid_operation",
              `board widget tool is not granted: ${boardParams.bindingId}`,
            );
          }
          const result = await readDataBinding(
            boardParams.bindingId,
            bindingParams,
            invocation,
            authority,
          );
          authority.assertActive();
          respond(true, result);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.action": defineValidatedGatewayMethod(
      "board.action",
      validateBoardActionParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket, {
            gatewayContext: context,
          });
          const capability =
            "jobId" in boardParams ? `cron.trigger:${boardParams.jobId}` : boardParams.action;
          if (!boardWidgetHasGrantedTool(document.declared, document.grantState, capability)) {
            throw new BoardValidationError(
              "invalid_operation",
              `board widget tool is not granted: ${capability}`,
            );
          }
          if ("jobId" in boardParams) {
            const result = await triggerCronJob(boardParams.jobId, invocation, authority);
            authority.assertActive();
            respond(true, result);
            return;
          }
          const actionParams = boardParams.params ?? {};
          assertCapabilityParamsSize(actionParams, "action");
          const result = await runActionVerb(
            boardParams.action,
            actionParams,
            invocation,
            authority,
          );
          authority.assertActive();
          respond(true, result);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
