import { BoardValidationError } from "../boards/board-layout.js";
import type { BoardStore, BoardWidgetDocument } from "../boards/board-store.js";
import { verifyBoardViewTicket } from "./board-view-ticket.js";

type AuthorizedBoardWidgetView = {
  sessionKey: string;
  name: string;
  document: Extract<BoardWidgetDocument, { html: string }>;
};

export function resolveAuthorizedBoardWidgetView(
  store: BoardStore,
  ticket: string,
  options: { nowMs?: number } = {},
): AuthorizedBoardWidgetView {
  const claims = verifyBoardViewTicket(ticket, options);
  if (!claims) {
    throw new BoardValidationError("invalid_operation", "board widget view ticket is invalid");
  }
  const document = store.readWidgetHtml(claims.sessionKey, claims.name);
  if (
    !document ||
    !("html" in document) ||
    (document.grantState !== "none" && document.grantState !== "granted") ||
    document.revision !== claims.revision ||
    document.viewGeneration !== claims.viewGeneration
  ) {
    throw new BoardValidationError("invalid_operation", "board widget view ticket is stale");
  }
  return { sessionKey: claims.sessionKey, name: claims.name, document };
}
