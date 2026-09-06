/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  createSessionPrefetchFixture,
  PREFETCH_TEST_NOW as NOW,
  prefetchSnapshotHost as snapshotHost,
  prefetchSessionRow as row,
  prefetchHistoryResult as historyResult,
  prefetchSessionKeyFromCall as sessionKeyFromCall,
  settleSessionPrefetch as settlePromises,
} from "./session-prefetch.test-support.ts";

describe("session prefetch pane and navigation ownership", () => {
  let fixture: ReturnType<typeof createSessionPrefetchFixture>;
  let cache: ChatMessageCache;
  let shell: HTMLElement;
  let updatePrefetch: ReturnType<typeof createSessionPrefetchFixture>["updatePrefetch"];
  beforeEach(() => {
    fixture = createSessionPrefetchFixture();
    ({ cache, shell, updatePrefetch } = fixture);
  });
  afterEach(async () => fixture.dispose());
  it.each(["pointerover", "focusin"])(
    "prioritizes the session receiving %s before idle history warming",
    async (eventType) => {
      const intended = "agent:main:intended";
      const request = vi.fn(async (_method: string, params: unknown) =>
        historyResult((params as { sessionKey: string }).sessionKey),
      );
      updatePrefetch({
        client: createTestGatewayClient(request),
        listRevision: 1,
        openSessionKeys: ["agent:main:foreground"],
        rows: [row("agent:main:newest", NOW), row("agent:main:recent", NOW - 1), row(intended, 1)],
      });
      const target = document.createElement("a");
      target.dataset.sessionKey = intended;
      shell.append(target);
      onTestFinished(() => target.remove());
      target.dispatchEvent(new Event(eventType, { bubbles: true }));

      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();

      expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([intended, "agent:main:newest"]);
      expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: intended })).not.toBeNull();
    },
  );

  it.each(["pointerover", "focusin"])(
    "keeps dashboard warming intent-only for %s and resumes with its conversation",
    async (eventType) => {
      const dashboard = "agent:main:dashboard";
      const intended = "agent:main:intended";
      const recent = "agent:main:recent";
      const request = vi.fn(async (_method: string, params: unknown) =>
        historyResult((params as { sessionKey: string }).sessionKey),
      );
      updatePrefetch({
        client: createTestGatewayClient(request),
        listRevision: 1,
        openSessionKeys: [dashboard],
        hiddenConversationSessionKeys: [dashboard],
        rows: [row(dashboard, NOW), row(recent, NOW - 1), row(intended, 1)],
      });
      const pane = fixture.host.firstElementChild as HTMLElement & {
        conversationPresented: boolean;
      };
      // A visible sibling Home conversation cannot opt the dashboard page into warming.
      const home = Object.assign(document.createElement("openclaw-chat-pane"), {
        sessionKey: "agent:main:home",
        conversationPresented: true,
        transcriptLoading: false,
      });
      shell.append(home);
      await vi.advanceTimersByTimeAsync(1_000);
      await settlePromises();
      expect(request).not.toHaveBeenCalled();

      const target = document.createElement("a");
      target.dataset.sessionKey = intended;
      shell.append(target);
      home.transcriptLoading = true;
      home.dispatchEvent(new Event("openclaw-chat-transcript-loading-changed", { bubbles: true }));
      target.dispatchEvent(new Event(eventType, { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request).not.toHaveBeenCalled();

      home.transcriptLoading = false;
      home.dispatchEvent(new Event("openclaw-chat-transcript-loading-changed", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([intended]);

      pane.conversationPresented = true;
      pane.dispatchEvent(new Event("openclaw-chat-pane-lifecycle-changed", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([intended, recent]);
    },
  );

  it.each(["stored read", "cursor reset"])(
    "rechecks dashboard intent after %s before another history request",
    async (phase) => {
      const dashboard = "agent:main:dashboard";
      const first = "agent:main:first";
      const next = "agent:main:next";
      const stored: ChatSessionSnapshot = {
        deltaCursor: "stored-cursor",
        messages: [],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "stored-first",
      };
      fixture.store.write(first, stored);
      await fixture.store.flush();
      cache.clear();
      const read = createDeferred<ChatSessionSnapshot | null>();
      const reset = createDeferred<{ kind: "reset"; reason: string }>();
      if (phase === "stored read") {
        vi.spyOn(fixture.store, "read").mockReturnValueOnce(read.promise);
      }
      const request = vi.fn(async (_method: string, params: unknown) =>
        (params as { sessionKey: string }).sessionKey === first
          ? reset.promise
          : historyResult(next),
      );
      updatePrefetch({
        client: createTestGatewayClient(request),
        listRevision: 1,
        openSessionKeys: [dashboard],
        hiddenConversationSessionKeys: [dashboard],
        rows: [row(first, NOW + 1), row(next, NOW)],
      });
      const target = document.createElement("a");
      target.dataset.sessionKey = first;
      shell.append(target);
      target.dispatchEvent(new Event("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(
        phase === "cursor reset" ? [first] : [],
      );

      target.dataset.sessionKey = next;
      target.dispatchEvent(new Event("pointerover", { bubbles: true }));
      if (phase === "stored read") {
        read.resolve(stored);
      } else {
        reset.resolve({ kind: "reset", reason: "stale-cursor" });
      }
      await settlePromises();
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(
        phase === "cursor reset" ? [first, next] : [next],
      );
    },
  );

  it("keeps automatic warming enabled while any owning-page conversation is visible", async () => {
    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    updatePrefetch({
      client: createTestGatewayClient(request),
      listRevision: 1,
      openSessionKeys: ["agent:main:selected", "agent:main:other"],
      hiddenConversationSessionKeys: ["agent:main:other"],
      rows: [row("agent:main:recent", NOW - 1)],
    });
    fixture.host.lastElementChild!.dispatchEvent(
      new Event("openclaw-chat-pane-lifecycle-changed", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent"]);
  });

  it("excludes the Home pane beside the page without borrowing another app's panes", async () => {
    const home = Object.assign(document.createElement("openclaw-chat-pane"), {
      sessionKey: "agent:main:main",
      transcriptLoading: false,
    });
    shell.append(home);
    const otherShell = document.createElement("openclaw-app-shell");
    otherShell.append(
      Object.assign(document.createElement("openclaw-chat-pane"), {
        sessionKey: "agent:main:recent",
        transcriptLoading: true,
      }),
    );
    document.body.append(otherShell);
    onTestFinished(() => otherShell.remove());
    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    updatePrefetch({
      client: createTestGatewayClient(request),
      listRevision: 1,
      openSessionKeys: ["agent:main:selected"],
      rows: [row(home.sessionKey, NOW), row("agent:main:recent", NOW - 1)],
    });

    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();

    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent"]);
  });

  it.each(["commit", "remove"])(
    "waits for the sibling Home transcript and resumes on %s",
    async (completion) => {
      const home = Object.assign(document.createElement("openclaw-chat-pane"), {
        sessionKey: "agent:main:main",
        transcriptLoading: false,
      });
      shell.append(home);
      const request = vi.fn(async (_method: string, params: unknown) =>
        historyResult((params as { sessionKey: string }).sessionKey),
      );
      updatePrefetch({
        client: createTestGatewayClient(request),
        listRevision: 1,
        openSessionKeys: ["agent:main:selected"],
        rows: [row(home.sessionKey, NOW), row("agent:main:recent", NOW - 1)],
      });
      // Home hydrates in its own update, without re-rendering the chat page.
      home.transcriptLoading = true;
      home.dispatchEvent(new Event("openclaw-chat-transcript-loading-changed", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request).not.toHaveBeenCalled();

      if (completion === "commit") {
        home.transcriptLoading = false;
        home.dispatchEvent(
          new Event("openclaw-chat-transcript-loading-changed", { bubbles: true }),
        );
      } else {
        home.remove();
        shell.dispatchEvent(new Event("openclaw-chat-pane-lifecycle-changed"));
      }
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(
        completion === "commit" ? ["agent:main:recent"] : [home.sessionKey, "agent:main:recent"],
      );
    },
  );
});
