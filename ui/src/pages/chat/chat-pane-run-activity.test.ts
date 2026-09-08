/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChat } from "./chat-view.ts";
import { resetChatComposerState } from "./components/chat-composer.ts";

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}

describe("chat pane run activity", () => {
  afterEach(() => resetChatComposerState());

  it.each([
    {
      name: "keeps a completed parent idle while its visible child runs",
      selectedKey: "agent:main:main",
      parentActive: false,
      expectWorking: false,
    },
    {
      name: "shows activity on the visible child itself",
      selectedKey: "agent:main:subagent:attachment-fix",
      parentActive: false,
      expectWorking: true,
    },
    {
      name: "shows activity while the parent has its own live turn",
      selectedKey: "agent:main:main",
      parentActive: true,
      expectWorking: true,
    },
  ])("$name", ({ selectedKey, parentActive, expectWorking }) => {
    const parentKey = "agent:main:main";
    const childKey = "agent:main:subagent:attachment-fix";
    const parent = {
      key: parentKey,
      kind: "direct",
      updatedAt: 2,
      status: parentActive ? "running" : "done",
      hasActiveRun: parentActive,
      activeRunIds: parentActive ? ["parent-run"] : [],
      hasActiveSubagentRun: true,
      childSessions: [childKey],
    } satisfies GatewaySessionRow;
    const child = {
      key: childKey,
      kind: "direct",
      updatedAt: 3,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["child-run"],
      subagentRunState: "active",
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      startedAt: 1,
    } satisfies GatewaySessionRow;
    const client = { request: async () => ({}) } as unknown as GatewayBrowserClient;
    const { pane, state, context } = createRefreshChatPane(client);
    context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
    state.sessionKey = selectedKey;
    state.sessionsResult = sessionsResult([parent, child]);
    pane.render();

    const container = document.createElement("div");
    render(renderChat(pane.chatProps!), container);

    expect(pane.chatProps?.canAbort).toBe(true);
    expect(container.querySelector(".chat-reading-indicator") !== null).toBe(expectWorking);
  });
});
