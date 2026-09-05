/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { readChatSessionSnapshot, type ChatMessageCache } from "./session-message-cache.ts";
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
        openSessionKeys: [],
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
