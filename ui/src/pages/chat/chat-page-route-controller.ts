import type { ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  sessionNavigationTarget,
  type SessionHistoryAnchor,
} from "../../lib/sessions/route-navigation.ts";
import { locationWithoutHistoryAnchor } from "./route-history-anchor.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

type ChatPageRouteHost = {
  context: () => ApplicationContext;
  data: () => SessionChatRouteData | undefined;
  requestUpdate: () => void;
};

type HistoryAnchorHandoff = {
  anchor: SessionHistoryAnchor;
  data: SessionChatRouteData;
};

export class ChatPageRouteController {
  private consumedHistoryAnchorData: SessionChatRouteData | null = null;

  constructor(private readonly host: ChatPageRouteHost) {}

  update(
    sessionKey: string,
    replace = false,
    face: BoardFace = this.host.data()?.face ?? "chat",
  ): void {
    const data = this.host.data();
    if (
      data?.sessionKey === sessionKey &&
      (data.face ?? "chat") === face &&
      !data.draft &&
      !data.focusComposer
    ) {
      return;
    }
    const context = this.host.context();
    const options = sessionNavigationTarget({
      context,
      face,
      sessionKey,
      agentId: data?.agentId,
      shortIdLength: data?.sessionKey === sessionKey ? data.shortId?.length : undefined,
    }).options;
    if (replace) {
      context.replace(face, options);
    } else {
      context.navigate(face, options);
    }
  }

  historyAnchor(active: boolean, sessionKey: string): HistoryAnchorHandoff | undefined {
    const data = this.host.data();
    return active &&
      data?.sessionKey === sessionKey &&
      this.consumedHistoryAnchorData !== data &&
      data.historyAnchor
      ? { anchor: data.historyAnchor, data }
      : undefined;
  }

  consumeHistoryAnchor(data: SessionChatRouteData): void {
    if (this.host.data() !== data || !data.historyAnchor) {
      return;
    }
    this.consumedHistoryAnchorData = data;
    const location = locationWithoutHistoryAnchor({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    });
    window.history.replaceState(
      window.history.state,
      "",
      `${location.pathname}${location.search}${location.hash}`,
    );
    this.host.requestUpdate();
  }
}
