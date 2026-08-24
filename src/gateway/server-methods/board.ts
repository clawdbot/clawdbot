import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type BoardActionParams,
  type BoardDataReadParams,
  type BoardEventParams,
  type BoardGetParams,
  type BoardPromptAuthorizeParams,
  type BoardWidgetAppViewParams,
  type BoardUpdateParams,
  type BoardWidgetGrantParams,
  type BoardWidgetMaterializedPutParams,
  type BoardWidgetPutParams,
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
import {
  boardWidgetHasGrantedTool,
  normalizeBoardWidgetDeclared,
} from "../../boards/board-capabilities.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import { appendBoardEventNotice, BoardEventPayloadError } from "../../boards/board-notices.js";
import type { BoardStore } from "../../boards/board-store.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import { buildWidgetDocument } from "../../canvas/wrap.js";
import {
  resolveBoardWidgetContentKind,
  resolveBoardWidgetContentKindByPluginKind,
  resolveBoardWidgetContentKindResourceUrls,
} from "../../plugins/board-widget-content-kinds.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  readBoardDataBinding,
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

function invalidParams(
  method: string,
  errors: unknown,
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors as never)}`,
    ),
  );
}

function respondBoardError(
  error: unknown,
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): void {
  if (error instanceof BoardValidationError || error instanceof BoardEventPayloadError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
}

function resolveBoardSessionKey(
  params: { sessionKey: string; agentId?: string | undefined },
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): string | undefined {
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
  return sessionObserverScopeKey(canonicalKey, requested.agentId);
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
    "board.get": async ({ params, respond, context, client }) => {
      if (!validateBoardGetParams(params)) {
        invalidParams("board.get", validateBoardGetParams.errors, respond);
        return;
      }
      const boardParams = params as BoardGetParams;
      const boardSessionKey = resolveBoardSessionKey(boardParams, context, respond);
      if (!boardSessionKey) {
        return;
      }
      const { snapshot, htmlViewMetadata } = store.getSnapshotWithHtmlViewMetadata(boardSessionKey);
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
          ? resolveBoardWidgetContentKindByPluginKind(getActivePluginRegistry(), widget.pluginKind)
          : undefined;
        const scopedHostUrl = registration
          ? client?.pluginSurfaceUrls?.[registration.definition.resources.surface]
          : undefined;
        const resourceUrls =
          registration && scopedHostUrl
            ? resolveBoardWidgetContentKindResourceUrls(registration, scopedHostUrl)
            : undefined;
        if (widget.contentKind === "plugin" && (!registration || !resourceUrls || !scopedHostUrl)) {
          continue;
        }
        const resourceOrigins = resourceUrls
          ? [...new Set(Object.values(resourceUrls).map((url) => new URL(url).origin))]
          : undefined;
        if (sandboxPort === undefined && context.ensureSandboxHostPort) {
          try {
            sandboxPort = await context.ensureSandboxHostPort();
          } catch (error) {
            respondBoardError(error, respond);
            return;
          }
        }
        const { ticket } = createBoardViewTicket({
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
        });
        if (registration) {
          widget.kindLabel = registration.definition.label;
        }
        widget.frameUrl = buildBoardWidgetFrameUrl({
          sessionKey: snapshot.sessionKey,
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
      respond(true, snapshot);
    },
    "board.update": ({ params, respond, context }) => {
      if (!validateBoardUpdateParams(params)) {
        invalidParams("board.update", validateBoardUpdateParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardUpdateParams;
        const boardSessionKey = resolveBoardSessionKey(boardParams, context, respond);
        if (!boardSessionKey) {
          return;
        }
        const snapshot = store.applyOps(boardSessionKey, boardParams.ops);
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
    "board.widget.put": async ({ params, respond, context }) => {
      if (!validateBoardWidgetPutParams(params)) {
        invalidParams("board.widget.put", validateBoardWidgetPutParams.errors, respond);
        return;
      }
      try {
        const requestParams = params as BoardWidgetPutParams;
        const requestedBoardSessionKey = resolveBoardSessionKey(requestParams, context, respond);
        if (!requestedBoardSessionKey) {
          return;
        }
        const boardSessionKey = store.getSnapshot(requestedBoardSessionKey).sessionKey;
        const {
          agentId: _agentId,
          declared: requestDeclared,
          ...requestWithoutDeclared
        } = requestParams;
        let content: BoardWidgetMaterializedPutParams["content"];
        let declared = requestDeclared;
        if (requestParams.content.kind === "canvas-doc") {
          const document = await readCanvasDocument(requestParams.content.docId);
          if (document.cspSandbox !== "scripts") {
            throw new BoardValidationError(
              "invalid_operation",
              `canvas document is not script-enabled: ${requestParams.content.docId}`,
            );
          }
          content = { kind: "html", html: document.html };
        } else if (requestParams.content.kind === "mcp-app") {
          const active = await mcpApp.resolveActiveView({
            sessionKey: boardSessionKey,
            viewId: requestParams.content.viewId,
            cfg: context.getRuntimeConfig(),
          });
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
          const allowedTools = interactive ? await mcpApp.resolveAllowedToolNames(active) : [];
          if (interactive) {
            try {
              await requireMcpAppInteraction(view);
            } catch {
              interactive = false;
            }
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
            getActivePluginRegistry(),
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
        if (!validateBoardWidgetContent(persistedContent)) {
          invalidParams("board.widget.put content", validateBoardWidgetContent.errors, respond);
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
                html: buildWidgetDocument(requestParams.title ?? requestParams.name, content.html, {
                  connectOrigins: declared?.netOrigins,
                }),
              }
            : content;
        const boardParams: BoardWidgetMaterializedPutParams = {
          ...requestWithoutDeclared,
          sessionKey: boardSessionKey,
          content: materializedContent,
          ...(declared ? { declared } : {}),
        };
        const snapshot = store.putWidget(boardParams);
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
    "board.widget.grant": ({ params, respond, context }) => {
      if (!validateBoardWidgetGrantParams(params)) {
        invalidParams("board.widget.grant", validateBoardWidgetGrantParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardWidgetGrantParams;
        const boardSessionKey = resolveBoardSessionKey(boardParams, context, respond);
        if (!boardSessionKey) {
          return;
        }
        const snapshot = store.grant(
          boardSessionKey,
          boardParams.name,
          boardParams.decision,
          boardParams.revision,
          boardParams.instanceId,
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
    "board.widget.appView": async ({ params, respond, context }) => {
      if (!validateBoardWidgetAppViewParams(params)) {
        invalidParams("board.widget.appView", validateBoardWidgetAppViewParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardWidgetAppViewParams;
        const boardSessionKey = resolveBoardSessionKey(boardParams, context, respond);
        if (!boardSessionKey) {
          return;
        }
        const snapshot = store.getSnapshot(boardSessionKey);
        const widget = snapshot.widgets.find((candidate) => candidate.name === boardParams.name);
        const document = store.readWidgetMcpApp(snapshot.sessionKey, boardParams.name);
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
              const current = store.readWidgetMcpApp(snapshot.sessionKey, boardParams.name);
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
          sessionKey: snapshot.sessionKey,
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
    "board.event": ({ params, respond, context }) => {
      if (!validateBoardEventParams(params)) {
        invalidParams("board.event", validateBoardEventParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardEventParams;
        const identity =
          "ticket" in boardParams
            ? resolveAuthorizedBoardWidgetView(store, boardParams.ticket)
            : (() => {
                const boardSessionKey = resolveBoardSessionKey(boardParams, context, respond);
                if (!boardSessionKey) {
                  return undefined;
                }
                const snapshot = store.getSnapshot(boardSessionKey);
                const widget = snapshot.widgets.some(
                  (candidate) => candidate.name === boardParams.widget,
                );
                if (!widget) {
                  throw new BoardValidationError(
                    "not_found",
                    `board widget not found: ${boardParams.widget}`,
                  );
                }
                return { sessionKey: snapshot.sessionKey, name: boardParams.widget };
              })();
        if (!identity) {
          return;
        }
        const appended = appendNotice({
          sessionKey: identity.sessionKey,
          widget: identity.name,
          payload: boardParams.payload,
        });
        respond(true, { ok: true, appended });
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.prompt.authorize": ({ params, respond }) => {
      if (!validateBoardPromptAuthorizeParams(params)) {
        invalidParams("board.prompt.authorize", validateBoardPromptAuthorizeParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardPromptAuthorizeParams;
        const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket);
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
    "board.data.read": async (invocation) => {
      const { params, respond } = invocation;
      if (!validateBoardDataReadParams(params)) {
        invalidParams("board.data.read", validateBoardDataReadParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardDataReadParams;
        const bindingParams = boardParams.params ?? {};
        assertCapabilityParamsSize(bindingParams, "data binding");
        const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket);
        if (
          !boardWidgetHasGrantedTool(document.declared, document.grantState, boardParams.bindingId)
        ) {
          throw new BoardValidationError(
            "invalid_operation",
            `board widget tool is not granted: ${boardParams.bindingId}`,
          );
        }
        respond(true, await readDataBinding(boardParams.bindingId, bindingParams, invocation));
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.action": async (invocation) => {
      const { params, respond } = invocation;
      if (!validateBoardActionParams(params)) {
        invalidParams("board.action", validateBoardActionParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardActionParams;
        const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket);
        const capability =
          "jobId" in boardParams ? `cron.trigger:${boardParams.jobId}` : boardParams.action;
        if (!boardWidgetHasGrantedTool(document.declared, document.grantState, capability)) {
          throw new BoardValidationError(
            "invalid_operation",
            `board widget tool is not granted: ${capability}`,
          );
        }
        if ("jobId" in boardParams) {
          respond(true, await triggerCronJob(boardParams.jobId, invocation));
          return;
        }
        const actionParams = boardParams.params ?? {};
        assertCapabilityParamsSize(actionParams, "action");
        respond(true, await runActionVerb(boardParams.action, actionParams, invocation));
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
