/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import { renderChat } from "./chat-view.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const defaults = { modelProvider: null, model: null, contextTokens: null };

afterEach(async () => {
  await resetComposerFixture();
});

it("blocks model setup without disabled-reason text", () => {
  const { pane, state, context } = createRefreshChatPane(
    createGatewayBrowserClientFixture({ recoveryScopeReady: true }),
  );
  state.sessionKey = "agent:main:setup";
  context.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "global",
    agents: [{ id: "main" }],
  };
  state.handleSendChat = vi.fn();
  pane.render();

  expect(pane.chatProps?.modelSetupRequired).toBe(true);
  expect(pane.chatProps?.disabledReason).toBeNull();
  expect(pane.chatProps?.canSend).toBe(false);
  void pane.chatProps?.onSend();
  expect(state.handleSendChat).not.toHaveBeenCalled();
});

describe("subagent composer", () => {
  it.each([
    { name: "subagent key", key: "agent:main:subagent:reply-owner" },
    {
      name: "spawn metadata",
      key: "agent:main:reply-owner",
      row: { spawnedBy: "agent:main:parent" },
    },
    { name: "archive", key: "agent:main:reply-owner", row: { archived: true } },
    {
      name: "restart recovery",
      key: "agent:main:reply-owner",
      row: { restartRecoveryStatus: "tombstoned" },
    },
  ] satisfies { name: string; key: string; row?: Partial<GatewaySessionRow> }[])(
    "keeps copy but not Reply when $name replaces the composer",
    ({ key, ...scenario }) => {
      installTranscriptDomMocks();
      const { pane, state } = createRefreshChatPane();
      state.sessionKey = key;
      state.sessionsResult = {
        ts: 1,
        path: "",
        count: "row" in scenario ? 1 : 0,
        defaults,
        sessions: "row" in scenario ? [{ key, kind: "direct", ...scenario.row }] : [],
      };
      state.chatLoading = false;
      state.chatMessages = [
        {
          role: "assistant",
          content: "The workspace review is complete.",
          timestamp: 1_000,
          __openclaw: { id: "review-result", seq: 1 },
        },
      ];
      const container = document.body.appendChild(document.createElement("div"));
      try {
        pane.render();
        render(renderChat(pane.chatProps!), container);
        expect(container.textContent).toContain("The workspace review is complete.");
        expect(container.querySelector("textarea")).toBeNull();
        expect(container.querySelector(".chat-reply-btn")).toBeNull();
        expect(container.querySelector(".chat-copy-btn")).not.toBeNull();
      } finally {
        render(nothing, container);
        pane.chatProps?.transcript.hostDisconnected();
        resetTranscriptTestDom();
      }
    },
  );

  it.each([
    { spawnedBy: "agent:main:parent" },
    { parentSessionKey: "agent:main:parent" },
    { spawnedBy: "agent:main:controller", parentSessionKey: "agent:main:parent" },
    { key: "agent:main:worker", spawnedBy: "agent:main:parent" },
  ])("replaces input with parent navigation for %j", (lineage) => {
    const { pane, state } = createRefreshChatPane();
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      kind: "direct",
      label: "Investigation request",
      updatedAt: 1,
    };
    const child: GatewaySessionRow = {
      key: "agent:main:subagent:worker",
      kind: "direct",
      label: "Check onboarding",
      updatedAt: 2,
      ...lineage,
    };
    state.sessionKey = child.key;
    state.sessionsResult = { ts: 2, path: "", count: 2, defaults, sessions: [parent, child] };
    state.chatMessage = "Retained draft";
    pane.onPaneSessionChange = vi.fn();
    state.handleSendChat = vi.fn();
    pane.render();
    const props = pane.chatProps!;
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(renderChatComposer({ ...props, canAbort: true, onAbort }), container);

    expect(props.canSend).toBe(false);
    void props.onSend();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(container.querySelector("textarea, input[type=file]")).toBeNull();
    expect(container.querySelector(".agent-chat__composer-footer")).toBeNull();
    const banner = container.querySelector(".agent-chat__disabled-banner");
    expect(banner?.textContent).toContain("View-only subagent");
    expect(banner?.textContent).toContain("Investigation request");
    banner?.querySelector<HTMLButtonElement>("button")?.click();
    expect(pane.onPaneSessionChange).toHaveBeenCalledWith(pane.paneId, parent.key);
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]');
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onAbort).toHaveBeenCalledOnce();
  });
  it.each([false, true])("keeps an unresolved subagent view-only with metadata=%s", (hasRow) => {
    const { pane, state } = createRefreshChatPane();
    state.sessionKey = "agent:main:subagent:unresolved";
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 0,
      defaults,
      sessions: hasRow
        ? [{ key: state.sessionKey, kind: "direct", updatedAt: 0, spawnedBy: "agent:main:missing" }]
        : [],
    };
    pane.render();
    const container = document.createElement("div");
    render(renderChatComposer(pane.chatProps!), container);
    expect(pane.chatProps?.canSend).toBe(false);
    expect(container.querySelector("textarea")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(".agent-chat__disabled-banner button")?.disabled,
    ).toBe(!hasRow);
    expect(container.querySelector('[aria-label="Stop generating"]')).toBeNull();
  });

  it.each([true, false])(
    "keeps an ordinary nested session reply editable while connected=%s",
    (connected) => {
      installTranscriptDomMocks();
      const { pane, state } = createRefreshChatPane(
        connected ? createGatewayBrowserClientFixture() : undefined,
      );
      state.sessionKey = "agent:main:fork";
      state.sessionsResult = {
        ts: 0,
        path: "",
        count: 1,
        defaults,
        sessions: [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 0,
            parentSessionKey: "agent:main:parent",
          },
        ],
      };
      state.chatLoading = false;
      state.chatMessage = "Keep this draft";
      state.chatMessages = [{ role: "assistant", content: "Review complete.", timestamp: 1_000 }];
      const container = document.body.appendChild(document.createElement("div"));
      const draw = () => {
        pane.render();
        render(renderChat(pane.chatProps!), container);
      };
      try {
        draw();
        expect(pane.chatProps?.canSend).toBe(true);
        expect(container.querySelector(".agent-chat__disabled-banner")).toBeNull();
        const reply = container.querySelector<HTMLButtonElement>(".chat-reply-btn");
        expect(reply).not.toBeNull();
        reply!.click();
        draw();
        expect(container.querySelector(".chat-reply-preview__text")?.textContent).toBe(
          "Review complete.",
        );
        expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
          "Keep this draft",
        );
      } finally {
        render(nothing, container);
        pane.chatProps?.transcript.hostDisconnected();
        resetTranscriptTestDom();
      }
    },
  );
});
