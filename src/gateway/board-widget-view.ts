import { BoardValidationError } from "../boards/board-layout.js";
import type { BoardStore, BoardWidgetDocument } from "../boards/board-store.js";
import { buildWidgetDocument } from "../canvas/wrap.js";
import {
  resolveBoardWidgetContentKindByPluginKind,
  resolveBoardWidgetContentKindResourceUrls,
} from "../plugins/board-widget-content-kinds.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
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
  const document = claims.pluginFrame
    ? store.readWidgetRegistered(claims.sessionKey, claims.name)
    : store.readWidgetHtml(claims.sessionKey, claims.name);
  if (
    !document ||
    (document.grantState !== "none" && document.grantState !== "granted") ||
    document.revision !== claims.revision ||
    document.viewGeneration !== claims.viewGeneration
  ) {
    throw new BoardValidationError("invalid_operation", "board widget view ticket is stale");
  }
  if (claims.pluginFrame) {
    if (!("source" in document) || document.pluginKind !== claims.pluginFrame.pluginKind) {
      throw new BoardValidationError("invalid_operation", "board widget view ticket is stale");
    }
    const registration = resolveBoardWidgetContentKindByPluginKind(
      getActivePluginRegistry(),
      document.pluginKind,
    );
    const resourceUrls = registration
      ? resolveBoardWidgetContentKindResourceUrls(registration, claims.pluginFrame.scopedHostUrl)
      : undefined;
    if (!registration || !resourceUrls) {
      throw new BoardValidationError(
        "invalid_operation",
        "board widget content kind is unavailable",
      );
    }
    const resourceOrigins = [
      ...new Set(Object.values(resourceUrls).map((url) => new URL(url).origin)),
    ];
    const body = registration.definition.composeDocument({
      source: document.source,
      title: document.title ?? claims.name,
      resourceUrls,
      promptGranted:
        document.grantState === "granted" && document.declared?.tools?.includes("prompt") === true,
    });
    const composed = {
      html: buildWidgetDocument(document.title ?? claims.name, body, {
        connectOrigins: document.declared?.netOrigins,
        scriptOrigins: resourceOrigins,
      }),
      revision: document.revision,
      sha256: document.sha256,
      viewGeneration: document.viewGeneration,
      grantState: document.grantState,
      ...(document.declared ? { declared: document.declared } : {}),
      resourceOrigins,
    };
    return { sessionKey: claims.sessionKey, name: claims.name, document: composed };
  }
  if (!("html" in document)) {
    throw new BoardValidationError("invalid_operation", "board widget view ticket is stale");
  }
  return { sessionKey: claims.sessionKey, name: claims.name, document };
}
