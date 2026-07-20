import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type BoardActionParams,
  type BoardDataReadParams,
  type BoardEventParams,
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
import { readBoardDataBinding, triggerBoardCronJob } from "../board-host-tools.js";
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
import type { GatewayRequestHandlers } from "./types.js";

type NoticeAppender = typeof appendBoardEventNotice;
type CanvasDocumentReader = typeof readCanvasDocumentHtmlSource;
type McpAppDependencies = {
  resolveActiveView: typeof resolveMcpAppActiveView;
  resolveAllowedToolNames: typeof resolveMcpAppAllowedToolNames;
  mintFromTranscript: typeof mintMcpAppViewFromTranscript;
};
type BoardDataReader = typeof readBoardDataBinding;
type BoardCronTrigger = typeof triggerBoardCronJob;
type BoardHandlerDependencies = Partial<McpAppDependencies> & {
  readDataBinding?: BoardDataReader;
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
  const triggerCronJob = dependencies.triggerCronJob ?? triggerBoardCronJob;
  return {
    "board.get": async ({ params, respond, context }) => {
      if (!validateBoardGetParams(params)) {
        invalidParams("board.get", validateBoardGetParams.errors, respond);
        return;
      }
      const snapshot = store.getSnapshot(params.sessionKey);
      let sandboxPort = context.getMcpAppSandboxPort?.();
      for (const widget of snapshot.widgets) {
        if (widget.grantState !== "none" && widget.grantState !== "granted") {
          continue;
        }
        const document = store.readWidgetHtml(snapshot.sessionKey, widget.name);
        if (!document || document.revision !== widget.revision) {
          continue;
        }
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
          viewGeneration: document.viewGeneration,
        });
        widget.frameUrl = buildBoardWidgetFrameUrl({
          sessionKey: snapshot.sessionKey,
          name: widget.name,
          ticket,
        });
        widget.viewTicket = ticket;
        widget.viewTicketTtlMs = BOARD_VIEW_TICKET_TTL_MS;
        widget.viewGeneration = document.viewGeneration;
        if (sandboxPort !== undefined) {
          widget.sandboxUrl = buildBoardWidgetSandboxPath(document);
          widget.sandboxPort = sandboxPort;
          const configuredOrigin = context.getRuntimeConfig?.().mcp?.apps?.sandboxOrigin;
          if (configuredOrigin) {
            widget.sandboxOrigin = new URL(configuredOrigin).origin;
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
        const snapshot = store.applyOps(boardParams.sessionKey, boardParams.ops);
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
        const boardSessionKey = store.getSnapshot(requestParams.sessionKey).sessionKey;
        const { declared: requestDeclared, ...requestWithoutDeclared } = requestParams;
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
          declared = allowedTools.length > 0 ? { tools: allowedTools } : undefined;
        } else {
          content = requestParams.content;
        }
        const persistedContent =
          content.kind === "mcp-app"
            ? { kind: content.kind, descriptor: content.descriptor }
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
          widget: boardParams.name,
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
        const snapshot = store.grant(
          boardParams.sessionKey,
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
        const snapshot = store.getSnapshot(boardParams.sessionKey);
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
    "board.event": ({ params, respond }) => {
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
                const snapshot = store.getSnapshot(boardParams.sessionKey);
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
        if (Buffer.byteLength(JSON.stringify(bindingParams), "utf8") > 8 * 1024) {
          throw new BoardValidationError(
            "invalid_operation",
            "board widget data binding params exceed 8192 UTF-8 bytes",
          );
        }
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
        const capability = `cron.trigger:${boardParams.jobId}`;
        if (!boardWidgetHasGrantedTool(document.declared, document.grantState, capability)) {
          throw new BoardValidationError(
            "invalid_operation",
            `board widget tool is not granted: ${capability}`,
          );
        }
        respond(true, await triggerCronJob(boardParams.jobId, invocation));
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
