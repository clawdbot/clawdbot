/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-route-controller.test/"} */

import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSION_HISTORY_MESSAGE_ID_PARAM,
  SESSION_HISTORY_SESSION_ID_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import { ChatPageRouteController } from "./chat-page-route-controller.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

function createRouteContext(replace = vi.fn()): ApplicationContext {
  return {
    basePath: "",
    sessions: { state: { result: null } },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    agentSelection: { state: { selectedId: "main" } },
    gateway: { snapshot: { hello: null } },
    navigate: vi.fn(),
    replace,
  } as unknown as ApplicationContext;
}

it("consumes a transcript anchor without remounting the chat route", () => {
  const search = new URLSearchParams({
    panel: "details",
    [SESSION_HISTORY_SESSION_ID_PARAM]: "historical-session",
    [SESSION_HISTORY_MESSAGE_ID_PARAM]: "historical-message",
  });
  window.history.replaceState({ marker: "preserved" }, "", `/chat/main?${search}`);
  const data: SessionChatRouteData = {
    sessionKey: "main",
    face: "chat",
    historyAnchor: {
      sessionId: "historical-session",
      messageId: "historical-message",
    },
  };
  const requestUpdate = vi.fn();
  const route = new ChatPageRouteController({
    context: () => undefined as never,
    data: () => data,
    requestUpdate,
  });

  const handoff = route.historyAnchor(true, "main");
  expect(handoff?.anchor).toEqual(data.historyAnchor);
  route.consumeHistoryAnchor(data);

  expect(window.location.pathname).toBe("/chat/main");
  expect(window.location.search).toBe("?panel=details");
  expect(window.history.state).toEqual({ marker: "preserved" });
  expect(requestUpdate).toHaveBeenCalledOnce();
  expect(route.historyAnchor(true, "main")).toBeUndefined();
});

it("preserves a transcript anchor while replacing a consumed draft route", () => {
  const replace = vi.fn();
  const data: SessionChatRouteData = {
    sessionKey: "main",
    face: "chat",
    draft: "follow up",
    focusComposer: true,
    historyAnchor: {
      sessionId: "historical-session",
      messageId: "historical-message",
    },
  };
  const route = new ChatPageRouteController({
    context: () => createRouteContext(replace),
    data: () => data,
    requestUpdate: vi.fn(),
  });

  route.update("main", true, "chat", { historyAnchor: data.historyAnchor });

  expect(replace).toHaveBeenCalledOnce();
  const options = replace.mock.calls[0]?.[1] as { search?: string } | undefined;
  const search = new URLSearchParams(options?.search);
  expect(search.get(SESSION_HISTORY_SESSION_ID_PARAM)).toBe("historical-session");
  expect(search.get(SESSION_HISTORY_MESSAGE_ID_PARAM)).toBe("historical-message");
  expect(search.has("draft")).toBe(false);
});
