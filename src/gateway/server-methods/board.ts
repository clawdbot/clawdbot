import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type BoardEventParams,
  type BoardUpdateParams,
  type BoardWidgetGrantParams,
  type BoardWidgetPutParams,
  validateBoardEventParams,
  validateBoardGetParams,
  validateBoardUpdateParams,
  validateBoardWidgetGrantParams,
  validateBoardWidgetPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import { appendBoardEventNotice, BoardEventPayloadError } from "../../boards/board-notices.js";
import type { BoardStore } from "../../boards/board-store.js";
import { boardStore } from "../board-store.js";
import { buildBoardWidgetFrameUrl, createBoardViewTicket } from "../board-view-ticket.js";
import type { GatewayRequestHandlers } from "./types.js";

type NoticeAppender = typeof appendBoardEventNotice;

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
): GatewayRequestHandlers {
  return {
    "board.get": ({ params, respond }) => {
      if (!validateBoardGetParams(params)) {
        invalidParams("board.get", validateBoardGetParams.errors, respond);
        return;
      }
      const snapshot = store.getSnapshot(params.sessionKey);
      for (const widget of snapshot.widgets) {
        if (widget.grantState !== "none" && widget.grantState !== "granted") {
          continue;
        }
        const document = store.readWidgetHtml(snapshot.sessionKey, widget.name);
        if (!document || !("html" in document) || document.revision !== widget.revision) {
          continue;
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
    "board.widget.put": ({ params, respond, context }) => {
      if (!validateBoardWidgetPutParams(params)) {
        invalidParams("board.widget.put", validateBoardWidgetPutParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardWidgetPutParams;
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
    "board.event": ({ params, respond }) => {
      if (!validateBoardEventParams(params)) {
        invalidParams("board.event", validateBoardEventParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardEventParams;
        const snapshot = store.getSnapshot(boardParams.sessionKey);
        const widget = snapshot.widgets.some((candidate) => candidate.name === boardParams.widget);
        if (!widget) {
          throw new BoardValidationError(
            "not_found",
            `board widget not found: ${boardParams.widget}`,
          );
        }
        const appended = appendNotice({
          sessionKey: snapshot.sessionKey,
          widget: boardParams.widget,
          payload: boardParams.payload,
        });
        respond(true, { ok: true, appended });
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
