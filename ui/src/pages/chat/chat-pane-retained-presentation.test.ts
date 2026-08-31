/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-retained.test/"} */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import {
  preparePaneStagedAttachments,
  restorePaneStagedAttachments,
} from "./chat-pane-attachment-handoff.ts";
import {
  clearPaneSessionHandoffs,
  consumePaneSessionHandoff,
  focusChatComposerFromPrintableKeydown,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { readTaskTranscript, type TaskDetailHost } from "./components/chat-task-detail-state.ts";

describe("chat pane retained presentation lifecycle", () => {
  it("expires abandoned eviction payload ownership", () => {
    vi.useFakeTimers();
    const id = "expired-retained-attachment";
    try {
      const { pane } = createTestChatPane({
        client: {} as GatewayBrowserClient,
        sessions: {} as SessionCapability,
      });
      const attachment = registerChatAttachmentPayload({
        attachment: { id, mimeType: "image/png" },
        dataUrl: "data:image/png;base64,ZXhwaXJlZA==",
        file: new File(["expired"], "expired.png", { type: "image/png" }),
      });
      preparePaneSessionHandoff(pane.context, "p1", "agent:main:expired", {
        attachments: [attachment],
        draft: "",
        restore: true,
      });

      vi.advanceTimersByTime(30_000);

      expect(consumePaneSessionHandoff(pane.context, "p1", "agent:main:expired")).toBeNull();
      expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    } finally {
      releaseChatAttachmentPayload(id);
      vi.useRealTimers();
    }
  });

  it("clears every unmounted eviction handoff for a permanently discarded pane", () => {
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const attachment = registerChatAttachmentPayload({
      attachment: { id: "permanently-discarded-attachment", mimeType: "image/png" },
      dataUrl: "data:image/png;base64,ZGlzY2FyZGVk",
      file: new File(["discarded"], "discarded.png", { type: "image/png" }),
    });
    preparePaneSessionHandoff(pane.context, "p1", "agent:main:evicted-a", {
      attachments: [attachment],
      draft: "evicted a",
      restore: true,
    });
    preparePaneSessionHandoff(pane.context, "p1", "agent:main:evicted-b", {
      attachments: [],
      draft: "evicted b",
      restore: true,
    });

    clearPaneSessionHandoffs(pane.context, "p1");

    expect(consumePaneSessionHandoff(pane.context, "p1", "agent:main:evicted-a")).toBeNull();
    expect(consumePaneSessionHandoff(pane.context, "p1", "agent:main:evicted-b")).toBeNull();
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("restores draft attachments and memory fallbacks after LRU eviction", () => {
    const source = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    source.pane.paneId = "p1";
    source.pane.presentationId = "p1:first";
    source.pane.sessionKey = "agent:main:first";
    source.state.sessionKey = "agent:main:first";
    source.state.chatMessage = "draft kept across eviction";
    source.state.chatAttachments = [
      { id: "attachment", mimeType: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ];
    source.state.chatComposerFallbackByScope = {
      fallback: {
        attachments: [{ id: "fallback-attachment", mimeType: "text/plain" }],
        message: "memory-only fallback",
        sequence: 1,
        storageFailed: true,
      },
    };

    source.pane.prepareForEviction();
    const owner = source.pane.context.gateway.snapshot.client;
    preparePaneStagedAttachments(source.pane.context, source.pane.paneId, source.state, owner);

    const destination = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    destination.pane.context = source.pane.context;
    destination.pane.paneId = "p1";
    destination.pane.presentationId = "p1:first-remount";
    destination.pane.sessionKey = "agent:main:first";
    destination.state.sessionKey = "agent:main:first";
    restorePaneStagedAttachments(
      destination.pane.context,
      destination.pane.paneId,
      destination.state,
      owner,
    );
    destination.pane.presented = false;
    destination.pane.presented = true;

    expect(destination.state.chatMessage).toBe("draft kept across eviction");
    expect(destination.state.chatAttachments).toEqual(source.state.chatAttachments);
    expect(destination.state.chatComposerFallbackByScope).toEqual(
      source.state.chatComposerFallbackByScope,
    );
  });

  it("delivers a one-shot continuation to the mounted destination and sends it", async () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.paneId = "p1";
    pane.sessionKey = "agent:main:continued";
    state.sessionKey = pane.sessionKey;
    state.handleChatDraftChange = vi.fn((draft) => {
      state.chatMessage = draft;
    });
    state.handleSendChat = vi.fn().mockResolvedValue(undefined);
    preparePaneSessionHandoff(pane.context, pane.paneId, pane.sessionKey, {
      attachments: [],
      draft: "continue from the catalog",
      send: true,
    });

    pane.presented = false;
    pane.presented = true;
    Object.defineProperty(pane, "active", { configurable: true, value: true });
    await Promise.resolve();

    expect(state.handleChatDraftChange).toHaveBeenCalledWith("continue from the catalog");
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  });

  it("schedules renders when an actual retained pane is hidden and reactivated", () => {
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.active = true;
    const requestUpdate = vi.spyOn(
      pane as unknown as { requestUpdate(name: PropertyKey, previous: unknown): void },
      "requestUpdate",
    );

    pane.presented = false;
    pane.active = false;
    pane.presented = true;
    pane.active = true;

    expect(
      requestUpdate.mock.calls.filter(([name]) => name === "presented" || name === "active"),
    ).toEqual([
      ["presented", true],
      ["active", true],
      ["presented", false],
      ["active", false],
    ]);
  });

  it("ignores an open dropdown in an inactive retained pane", () => {
    const app = document.body.appendChild(document.createElement("openclaw-app"));
    const activePane = app.appendChild(document.createElement("section"));
    const composer = document.createElement("div");
    composer.className = "agent-chat__composer-combobox";
    const textarea = composer.appendChild(document.createElement("textarea"));
    activePane.append(composer);
    const focus = vi.spyOn(textarea, "focus");
    const target = activePane.appendChild(document.createElement("main"));
    target.addEventListener("keydown", (event) =>
      focusChatComposerFromPrintableKeydown(activePane, event),
    );
    const retainedPane = app.appendChild(document.createElement("div"));
    retainedPane.setAttribute("inert", "");
    const retainedDropdown = retainedPane.appendChild(
      document.createElement("wa-dropdown"),
    ) as HTMLElement & { open: boolean };
    retainedDropdown.open = true;

    try {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true }),
      );

      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      app.remove();
    }
  });

  it("retires foreground-only state when a retained pane is hidden", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const stop = vi.fn();
    const release = vi.fn();
    state.realtimeTalkSession = { stop } as unknown as ChatPageHost["realtimeTalkSession"];
    state.realtimeTalkActive = true;
    state.sidebarContent = { kind: "task", taskId: "task-live" };
    state.imageLightbox = { release, src: "blob:test", title: "preview" };
    const detailHost = state as unknown as TaskDetailHost;
    readTaskTranscript(detailHost, {
      taskId: "task-live",
      sessionKey: "agent:main:subagent:task-live",
    });
    expect(detailHost.taskDetailState).toBeDefined();
    pane.presentationId = "p1:visible";
    const announcement = document.createElement("span");
    announcement.className = "chat-transcript-announcement";
    announcement.setAttribute("aria-live", "polite");
    pane.append(announcement);
    pane.presented = false;

    expect(stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(state.sidebarContent).toBeNull();
    // The wiped detail slot can no longer reset the loader itself; retirement
    // must stop its timer/fetch loop so hidden panes stop reading history.
    expect(detailHost.taskDetailState).toBeUndefined();
    expect(announcement.getAttribute("aria-live")).toBe("off");
  });

  it("does not stage a created-session handoff when its logical pane rejects navigation", async () => {
    const sessions = {
      create: vi.fn().mockResolvedValue("agent:main:rejected-created-session"),
    } as unknown as SessionCapability;
    const { pane } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
    advertiseSessionCreate(pane);
    pane.onPaneSessionChange = vi.fn(() => false);

    await expect(pane.createSession()).resolves.toBe(false);

    expect(
      consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:rejected-created-session"),
    ).toBeNull();
  });
});

function advertiseSessionCreate(pane: TestChatPane) {
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.write"] },
    features: { methods: ["sessions.create"] },
  } as typeof pane.context.gateway.snapshot.hello;
}
