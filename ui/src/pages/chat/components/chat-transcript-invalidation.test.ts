/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import { resolveAssistantAttachmentAuthToken } from "../chat-pane-state.ts";
import { createTestChatPane } from "../chat-pane.test-support.ts";
import * as chatThreadBuild from "../chat-thread-build.ts";
import {
  buildCachedChatItems,
  getExpandedToolCards,
  getExpandedUserMessages,
  getExpansionStateVersion,
} from "../chat-thread.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import {
  isChatMediaResourceCurrent,
  observeChatMediaResource,
  releaseChatMediaResourceSubscriber,
} from "./chat-message-media.ts";
import { resetTranscriptSession } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

describe("chat transcript invalidation", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("keeps built row identities across an A to B to A presentation reset", () => {
    const paneId = "pane-session-items";
    const messagesA = [{ role: "assistant", content: "session A", timestamp: 1_000 }];
    const messagesB = [{ role: "assistant", content: "session B", timestamp: 2_000 }];
    const stableInputs = {
      paneId,
      runId: null,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    };
    const buildSpy = vi.spyOn(chatThreadBuild, "buildChatItems");
    const itemsA = buildCachedChatItems({
      ...stableInputs,
      sessionKey: "agent:main:session-a",
      messages: messagesA,
    });

    resetTranscriptSession(paneId);
    buildCachedChatItems({
      ...stableInputs,
      sessionKey: "agent:main:session-b",
      messages: messagesB,
    });
    resetTranscriptSession(paneId);
    const restoredItemsA = buildCachedChatItems({
      ...stableInputs,
      sessionKey: "agent:main:session-a",
      messages: messagesA,
    });

    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(restoredItemsA).toBe(itemsA);
    expect(restoredItemsA.every((item, index) => item === itemsA[index])).toBe(true);
  });

  it("rebinds guarded transcript images when the gateway rotates its auth token", async () => {
    const NativeUrl = URL;
    const blobUrl = `blob:transcript-media-${crypto.randomUUID()}`;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => blobUrl);
        static override revokeObjectURL = vi.fn();
      },
    );

    let previousSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_source: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          previousSignal = init?.signal ?? undefined;
          previousSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("media scope changed", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const client = {
      request: vi.fn(async () => null),
    } as unknown as Parameters<typeof createTestChatPane>[0]["client"];
    const sessions = {} as Parameters<typeof createTestChatPane>[0]["sessions"];
    const { pane, state } = createTestChatPane({ client, sessions });
    state.hello = {
      auth: { deviceToken: "test-auth-token" },
    } as typeof state.hello;
    const messages = [
      {
        role: "assistant",
        content: [{ type: "image", url: source }],
        timestamp: 1_000,
      },
    ];
    const renderPane = () => {
      render(
        renderChatThread(
          {
            ...threadProps("pane-gateway-media-auth", state.sessionKey, messages),
            assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
            onRequestUpdate: renderPane,
          },
          transcript,
        ),
        container,
      );
      transcript.hostUpdated();
    };
    state.requestUpdate = renderPane;

    renderPane();
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const thumbnailSource = source.replace(/\/full$/u, "/thumbnail");
    const previousResource = observeChatMediaResource<string | null>(
      "managed-image",
      `${thumbnailSource}::test-auth-token::`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(previousResource.subscribers.size).toBe(1);

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "connected",
      hello: {
        ...pane.context.gateway.snapshot.hello,
        auth: { deviceToken: "test-token" },
      } as typeof pane.context.gateway.snapshot.hello,
    });
    expect(previousSignal?.aborted).toBe(true);
    expect(isChatMediaResourceCurrent(previousResource)).toBe(false);
    await flushDeferredRowPrune();

    const nextResource = observeChatMediaResource<string | null>(
      "managed-image",
      `${thumbnailSource}::test-token::`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    expect(isChatMediaResourceCurrent(nextResource)).toBe(true);
    expect(nextResource.subscribers.size).toBe(1);
    expect(container.querySelector<HTMLImageElement>(".chat-message-image")?.src).toBe(blobUrl);

    releaseChatMediaResourceSubscriber(renderPane);
    transcript.hostDisconnected();
  });

  it("reconciles guarded local attachments when pane preview roots change", async () => {
    let previousSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_source: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          previousSignal = init?.signal ?? undefined;
          previousSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("preview roots changed", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "root-restored-ticket",
          mediaTicketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = {
      request: vi.fn(async () => null),
    } as unknown as Parameters<typeof createTestChatPane>[0]["client"];
    const sessions = {} as Parameters<typeof createTestChatPane>[0]["sessions"];
    const { pane, state } = createTestChatPane({ client, sessions });
    const configPane = pane as typeof pane & {
      applyApplicationConfig: (config: typeof pane.context.config.current) => void;
    };
    state.hello = {
      auth: { deviceToken: "test-auth-token" },
    } as typeof state.hello;
    state.localMediaPreviewRoots = ["/tmp/openclaw"];
    state.embedSandboxMode = "scripts";
    state.allowExternalEmbedUrls = false;

    const source = `/tmp/openclaw/${crypto.randomUUID()}.pdf`;
    const messages = [
      {
        role: "assistant",
        content: `Local document\nMEDIA:${source}`,
        timestamp: 1_000,
      },
    ];
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const renderPane = () => {
      render(
        renderChatThread(
          {
            ...threadProps("pane-local-media-roots", state.sessionKey, messages),
            assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
            localMediaPreviewRoots: state.localMediaPreviewRoots,
            onRequestUpdate: renderPane,
          },
          transcript,
        ),
        container,
      );
      transcript.hostUpdated();
    };
    state.requestUpdate = renderPane;

    renderPane();
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const previousResource = observeChatMediaResource(
      "assistant-attachment",
      `::test-auth-token::${source}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(previousResource.subscribers.size).toBe(1);

    const config = {
      ...pane.context.config.current,
      localMediaPreviewRoots: ["/tmp/elsewhere"],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
    };
    configPane.applyApplicationConfig(config);
    await flushDeferredRowPrune();

    expect(previousSignal?.aborted).toBe(true);
    expect(isChatMediaResourceCurrent(previousResource)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(".chat-assistant-attachment-card__reason")?.textContent,
    ).toContain("Outside allowed folders");

    configPane.applyApplicationConfig({
      ...config,
      localMediaPreviewRoots: ["/tmp/openclaw"],
    });
    await flushDeferredRowPrune();

    const restoredResource = observeChatMediaResource(
      "assistant-attachment",
      `::test-auth-token::${source}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer test-auth-token",
    );
    expect(isChatMediaResourceCurrent(restoredResource)).toBe(true);
    expect(restoredResource.subscribers.size).toBe(1);
    expect(
      container.querySelector(".chat-assistant-attachment-card__link")?.getAttribute("href"),
    ).toContain("mediaTicket=root-restored-ticket");

    releaseChatMediaResourceSubscriber(renderPane);
    transcript.hostDisconnected();
  });

  it("updates MCP App pinning when the same provider's capability changes", async () => {
    const provider = {
      sessionKey: "agent:main:main",
      canPinWidgets: true,
      canPinMcpApps: false,
      pinMcpApp: vi.fn(async () => undefined),
      snapshot$: {
        value: {
          sessionKey: "agent:main:main",
          revision: 1,
          tabs: [],
          widgets: [],
        },
        subscribe: () => () => undefined,
      },
    };
    const props = {
      ...threadProps("pane-mcp-capability"),
      boardProvider: provider as unknown as BoardProvider,
      messages: [
        {
          role: "assistant",
          timestamp: 1_000,
          content: [
            { type: "text", text: "Here is the dashboard app." },
            {
              type: "canvas",
              preview: {
                kind: "canvas",
                surface: "assistant_message",
                render: "url",
                title: "Dashboard app",
                viewId: "outer-view-must-not-be-pinned",
                mcpApp: {
                  viewId: "view-dashboard-app",
                  serverName: "dashboard",
                  toolName: "show",
                  uiResourceUri: "ui://dashboard/app.html",
                  toolCallId: "call-dashboard-app",
                  originSessionKey: "agent:main:main",
                },
              },
            },
          ],
        },
      ],
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));

    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    expect(container.querySelector('[data-content-kind="mcp-app"]')).not.toBeNull();
    expect(container.querySelector("[data-pin-widget]")).toBeNull();

    provider.canPinMcpApps = true;
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();

    expect(container.querySelector("[data-pin-widget]")).not.toBeNull();
    expect(provider.snapshot$.value.revision).toBe(1);

    provider.canPinMcpApps = false;
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();

    expect(container.querySelector("[data-pin-widget]")).toBeNull();
    expect(provider.snapshot$.value.revision).toBe(1);
  });

  it("keeps mounted disclosure handlers attached to recreated session expansion maps", () => {
    const sessionKey = "retained-session";
    const props = {
      ...threadProps("retained-pane", sessionKey, [
        { role: "user", content: "long user message ".repeat(100), timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "assistant reply" },
            { type: "toolcall", id: "retained-call", name: "browser.open" },
          ],
          timestamp: 2,
        },
      ]),
      showToolCalls: true,
    };
    const controller = createTestTranscript();
    const retainedPane = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, controller), retainedPane);
    const staleTools = getExpandedToolCards(sessionKey);
    const staleUsers = getExpandedUserMessages(sessionKey);
    const previousToolVersion = getExpansionStateVersion(staleTools);
    const previousUserVersion = getExpansionStateVersion(staleUsers);

    for (let index = 0; index < 20; index += 1) {
      const alternatePane = document.body.appendChild(document.createElement("div"));
      render(
        renderChatThread(
          {
            ...props,
            paneId: `alternate-pane-${index}`,
            sessionKey: `alternate-session-${index}`,
          },
          createTestTranscript(),
        ),
        alternatePane,
      );
    }

    render(renderChatThread(props, controller), retainedPane);
    const currentTools = getExpandedToolCards(sessionKey);
    const currentUsers = getExpandedUserMessages(sessionKey);
    expect(currentTools).not.toBe(staleTools);
    expect(currentUsers).not.toBe(staleUsers);
    expect(getExpansionStateVersion(currentTools)).toBe(previousToolVersion);
    expect(getExpansionStateVersion(currentUsers)).toBe(previousUserVersion);
    const toolCardId = expectDefined(currentTools.keys().next().value, "retained tool card");
    expectDefined(
      retainedPane.querySelector<HTMLButtonElement>(
        ".chat-group.user .chat-message-disclosure__toggle",
      ),
      "mounted user disclosure",
    ).click();
    expectDefined(
      retainedPane.querySelector<HTMLButtonElement>(".chat-tool-msg-summary"),
      "mounted tool disclosure",
    ).click();

    expect(currentTools.get(toolCardId)).toBe(true);
    expect(staleTools.get(toolCardId)).toBe(false);
    expect(currentUsers.size).toBe(1);
    expect(staleUsers.size).toBe(0);

    const toolVisibilitySession = "tool-visibility-session";
    const toolVisibilityProps = {
      ...props,
      paneId: "tool-visibility-pane",
      sessionKey: toolVisibilitySession,
      messages: [
        { role: "user", content: "tool visibility prompt", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "expanded-tool",
          toolName: "browser.open",
          content: "Expanded tool result",
          timestamp: 2,
        },
        { role: "assistant", content: "The first tool completed.", timestamp: 3 },
        { role: "user", content: "Show the next tool result.", timestamp: 4 },
        {
          role: "toolResult",
          toolCallId: "collapsed-tool",
          toolName: "browser.open",
          content: "Collapsed tool result",
          timestamp: 5,
        },
      ],
    };
    const toolVisibilityController = createTestTranscript();
    const toolVisibilityPane = document.body.appendChild(document.createElement("div"));
    const renderToolVisibility = (next = toolVisibilityProps) =>
      render(renderChatThread(next, toolVisibilityController), toolVisibilityPane);
    renderToolVisibility();
    const visibilityState = getExpandedToolCards(toolVisibilitySession);
    const visibilityIds = [...visibilityState.keys()].filter((key) => key.startsWith("toolmsg:"));
    const expandedToolId = expectDefined(visibilityIds[0], "expanded standalone tool disclosure");
    const collapsedToolId = expectDefined(visibilityIds[1], "collapsed standalone tool disclosure");
    const disclosureButtons = () =>
      Array.from(
        toolVisibilityPane.querySelectorAll<HTMLButtonElement>(".chat-tool-msg-summary"),
      ).filter((button) => !button.closest(".chat-tool-msg-body"));
    expect(disclosureButtons()).toHaveLength(2);
    expect(disclosureButtons().map((button) => button.getAttribute("aria-expanded"))).toEqual([
      "false",
      "false",
    ]);
    expectDefined(disclosureButtons()[0], "first mounted tool disclosure").click();
    renderToolVisibility();
    expectDefined(disclosureButtons()[1], "second mounted tool disclosure").click();
    renderToolVisibility();
    expectDefined(disclosureButtons()[1], "second mounted tool disclosure").click();
    renderToolVisibility();
    expect(disclosureButtons().map((button) => button.getAttribute("aria-expanded"))).toEqual([
      "true",
      "false",
    ]);

    renderToolVisibility({ ...toolVisibilityProps, showToolCalls: false });
    expect(disclosureButtons()).toHaveLength(0);
    renderToolVisibility();

    expect(disclosureButtons()).toHaveLength(2);
    expect(disclosureButtons().map((button) => button.getAttribute("aria-expanded"))).toEqual([
      "true",
      "false",
    ]);
    expect(visibilityState.get(expandedToolId)).toBe(true);
    expect(visibilityState.get(collapsedToolId)).toBe(false);
    renderToolVisibility({
      ...toolVisibilityProps,
      messages: toolVisibilityProps.messages.filter(
        (message) => !("toolCallId" in message && message.toolCallId === "expanded-tool"),
      ),
    });
    expect(visibilityState.has(expandedToolId)).toBe(false);
    expect(visibilityState.get(collapsedToolId)).toBe(false);
  });
});
