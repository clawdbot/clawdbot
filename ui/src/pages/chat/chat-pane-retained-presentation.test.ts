/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-retained.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import {
  preparePaneStagedAttachments,
  restorePaneStagedAttachments,
} from "./chat-pane-attachment-handoff.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  clearPaneSessionHandoffs,
  consumePaneSessionHandoff,
  focusChatComposerFromPrintableKeydown,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { readTaskTranscript, type TaskDetailHost } from "./components/chat-task-detail-state.ts";
import { openSlot } from "./sidebar-layout.ts";

describe("chat pane retained presentation lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])(
    "restores sidebar tabs without opening a compact=%s presentation",
    (compact) => {
      vi.stubGlobal("localStorage", createStorageMock());
      const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
      const layout = openSlot({ columns: [] }, "workspace");
      patchSettings({ sidebarSessionLayouts: { [state.sessionKey]: layout } });
      (pane as TestChatPane & { compact: boolean }).compact = compact;
      pane.connectedClient = null;

      pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot, phase: "reconnecting" });

      expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("workspace");
      expect(state.sidebarLayout.open).toBe(!compact);
      expect(loadSettings().sidebarSessionLayouts?.[state.sessionKey]?.open).toBe(true);
    },
  );

  it("hands native drafts and typing to the focused region without changing the work session", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const page = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const dock = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const listeners = new Set<(draft: string) => void>();
    page.pane.context.nativeChatDrafts.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    dock.pane.context = page.pane.context;
    const panes = [page, dock].map(({ pane, state }, index) => {
      const mounted = pane as TestChatPane & { inputRegion: "page" | "dock"; render(): null };
      mounted.inputRegion = index === 0 ? "page" : "dock";
      mounted.sessionKey = index === 0 ? "agent:work:task" : "agent:main:main";
      state.sessionKey = mounted.sessionKey;
      state.settings = {
        sessionKey: "agent:work:task",
        lastActiveSessionKey: "agent:work:task",
      } as ChatPageHost["settings"];
      state.handleChatDraftChange = vi.fn();
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      mounted.render = () => null;
      mounted.active = true;
      const composer = document.createElement("div");
      composer.className = "agent-chat__composer-combobox";
      const textarea = composer.appendChild(document.createElement("textarea"));
      mounted.append(composer);
      const focus = vi.spyOn(textarea, "focus");
      ChatPaneBase.prototype.connectedCallback.call(mounted);
      return { mounted, focus, state };
    });
    try {
      await Promise.all(panes.map(({ mounted }) => mounted.updateComplete));
      const owner = chatInputOwnerForContext(page.pane.context);
      for (const region of ["dock", "page"] as const) {
        owner.claim(region);
        expect(listeners.size).toBe(1);
        for (const listener of listeners) {
          listener(region);
        }
        const key = new KeyboardEvent("keydown", { key: "x", cancelable: true });
        for (const { mounted } of panes) {
          mounted.handleDocumentKeydown(key);
        }
      }
      expect(page.state.handleChatDraftChange).toHaveBeenCalledExactlyOnceWith("page", []);
      expect(dock.state.handleChatDraftChange).toHaveBeenCalledExactlyOnceWith("dock", []);
      for (const { focus } of panes) {
        expect(focus).toHaveBeenCalledOnce();
      }
      expect(page.pane.context.gateway.setSessionKey).not.toHaveBeenCalled();
      expect(page.pane.context.agentSelection.state.selectedId).toBe("main");
    } finally {
      for (const { mounted } of panes) {
        mounted.active = false;
        Object.defineProperty(mounted, "isConnected", { configurable: true, value: false });
        ChatPaneBase.prototype.disconnectedCallback.call(mounted);
      }
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

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

    expect(state.handleChatDraftChange).toHaveBeenCalledWith("continue from the catalog", []);
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

  it.each([false, true])(
    "stages a created-session draft only when its pane accepts navigation (%s)",
    async (accepted) => {
      const nextSessionKey = "agent:main:created-session";
      const sessions = {
        create: vi.fn().mockResolvedValue(nextSessionKey),
      } as unknown as SessionCapability;
      const { pane, state } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
      advertiseSessionCreate(pane);
      pane.onPaneSessionChange = vi.fn(() => accepted);
      state.chatMessage = "@Alex continue";
      const mention = { profileId: "original-profile", start: 0, end: 5 };
      state.chatMentions = [mention];

      await expect(pane.createSession()).resolves.toBe(accepted);
      mention.profileId = "replacement-profile";

      expect(consumePaneSessionHandoff(pane.context, pane.paneId, nextSessionKey)).toEqual(
        accepted
          ? {
              attachments: [],
              draft: "@Alex continue",
              mentions: [{ profileId: "original-profile", start: 0, end: 5 }],
            }
          : null,
      );
    },
  );
});

function advertiseSessionCreate(pane: TestChatPane) {
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.write"] },
    features: { methods: ["sessions.create"] },
  } as typeof pane.context.gateway.snapshot.hello;
}
