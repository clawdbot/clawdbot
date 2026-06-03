/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { realtimeTalkCtor, startMock, stopMock } = vi.hoisted(() => ({
  realtimeTalkCtor: vi.fn(),
  startMock: vi.fn(),
  stopMock: vi.fn(),
}));

describe("OpenClawApp Talk controls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("./chat/realtime-talk.ts", () => ({
      RealtimeTalkSession: realtimeTalkCtor,
    }));
    realtimeTalkCtor.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
    realtimeTalkCtor.mockImplementation(
      function MockRealtimeTalkSession(this: { start: typeof startMock; stop: typeof stopMock }) {
        this.start = startMock;
        this.stop = stopMock;
      },
    );
    startMock.mockResolvedValue(undefined);
  });

  it("retries Talk immediately when the previous session is already in error state", async () => {
    const { OpenClawApp } = await import("./app.ts");
    const app = Object.create(OpenClawApp.prototype) as {
      client: unknown;
      connected: boolean;
      lastError: string | null;
      realtimeTalkActive: boolean;
      realtimeTalkDetail: string | null;
      realtimeTalkConversation: Array<{ id: string; role: string; text: string }>;
      realtimeTalkStatus: string;
      realtimeTalkSession: { stop(): void } | null;
      realtimeTalkTranscript: string | null;
      sessionKey: string;
    };
    const staleStop = vi.fn();
    Object.defineProperties(app, {
      client: { value: { request: vi.fn() }, writable: true },
      connected: { value: true, writable: true },
      lastError: { value: null, writable: true },
      realtimeTalkActive: { value: true, writable: true },
      realtimeTalkConversation: { value: [], writable: true },
      realtimeTalkDetail: { value: null, writable: true },
      realtimeTalkSession: { value: { stop: staleStop }, writable: true },
      realtimeTalkStatus: { value: "error", writable: true },
      realtimeTalkTranscript: { value: null, writable: true },
      sessionKey: { value: "main", writable: true },
    });

    await OpenClawApp.prototype.toggleRealtimeTalk.call(app as never);

    expect(staleStop).toHaveBeenCalledOnce();
    expect(realtimeTalkCtor).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledOnce();
    expect(stopMock).not.toHaveBeenCalled();
    expect(app.realtimeTalkStatus).toBe("connecting");
    const session = app.realtimeTalkSession as { start?: unknown; stop?: unknown } | undefined;
    expect(session?.start).toBe(startMock);
    expect(session?.stop).toBe(stopMock);
  });

  it("accumulates Talk transcripts as ordered conversation turns", async () => {
    const { OpenClawApp } = await import("./app.ts");
    const app = Object.create(OpenClawApp.prototype) as {
      client: unknown;
      connected: boolean;
      lastError: string | null;
      realtimeTalkActive: boolean;
      realtimeTalkConversation: Array<{ role: string; text: string; isStreaming: boolean }>;
      realtimeTalkDetail: string | null;
      realtimeTalkStatus: string;
      realtimeTalkSession: { stop(): void } | null;
      realtimeTalkTranscript: string | null;
      sessionKey: string;
    };
    Object.defineProperties(app, {
      client: { value: { request: vi.fn() }, writable: true },
      connected: { value: true, writable: true },
      lastError: { value: null, writable: true },
      realtimeTalkActive: { value: false, writable: true },
      realtimeTalkConversation: { value: [], writable: true },
      realtimeTalkDetail: { value: null, writable: true },
      realtimeTalkSession: { value: null, writable: true },
      realtimeTalkStatus: { value: "idle", writable: true },
      realtimeTalkTranscript: { value: null, writable: true },
      sessionKey: { value: "main", writable: true },
    });

    await OpenClawApp.prototype.toggleRealtimeTalk.call(app as never);
    const callbacks = realtimeTalkCtor.mock.calls[0]?.[2] as
      | {
          onTranscript?: (entry: {
            role: "user" | "assistant";
            text: string;
            final: boolean;
          }) => void;
        }
      | undefined;

    callbacks?.onTranscript?.({ role: "user", text: "Turn off", final: false });
    callbacks?.onTranscript?.({ role: "user", text: "the lights", final: false });
    callbacks?.onTranscript?.({ role: "assistant", text: "Checking", final: false });
    callbacks?.onTranscript?.({ role: "user", text: "Second request", final: true });

    expect(app.realtimeTalkConversation).toMatchObject([
      { role: "user", text: "Turn off the lights", isStreaming: false },
      { role: "assistant", text: "Checking", isStreaming: false },
      { role: "user", text: "Second request", isStreaming: false },
    ]);
  });

  it("routes Talk startup failures through the chat error surface", async () => {
    startMock.mockRejectedValueOnce(new Error("voice provider missing"));
    const { OpenClawApp } = await import("./app.ts");
    const app = Object.create(OpenClawApp.prototype) as {
      chatError: string | null;
      client: unknown;
      connected: boolean;
      lastError: string | null;
      realtimeTalkActive: boolean;
      realtimeTalkConversation: Array<{ role: string; text: string; isStreaming: boolean }>;
      realtimeTalkDetail: string | null;
      realtimeTalkStatus: string;
      realtimeTalkSession: { stop(): void } | null;
      realtimeTalkTranscript: string | null;
      sessionKey: string;
    };
    Object.defineProperties(app, {
      chatError: { value: "previous chat failure", writable: true },
      client: { value: { request: vi.fn() }, writable: true },
      connected: { value: true, writable: true },
      lastError: { value: "previous chat failure", writable: true },
      realtimeTalkActive: { value: false, writable: true },
      realtimeTalkConversation: { value: [], writable: true },
      realtimeTalkDetail: { value: null, writable: true },
      realtimeTalkSession: { value: null, writable: true },
      realtimeTalkStatus: { value: "idle", writable: true },
      realtimeTalkTranscript: { value: null, writable: true },
      sessionKey: { value: "main", writable: true },
    });

    await OpenClawApp.prototype.toggleRealtimeTalk.call(app as never);

    expect(app.lastError).toBe("voice provider missing");
    expect(app.chatError).toBe("voice provider missing");
    expect(stopMock).toHaveBeenCalledOnce();
  });

  it("keeps the Talk options toggle inside the open-panel click guard", async () => {
    await import("./app.ts");
    const app = document.createElement("openclaw-app");
    const guardHost = app as unknown as {
      chatMobileControlsPointerdownHandler: (event: Event) => void;
      realtimeTalkOptionsOpen: boolean;
    };
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-label", "Talk options");
    app.append(toggle);

    guardHost.realtimeTalkOptionsOpen = true;
    guardHost.chatMobileControlsPointerdownHandler({
      composedPath: () => [toggle, app, document, window],
    } as unknown as Event);

    expect(guardHost.realtimeTalkOptionsOpen).toBe(true);

    guardHost.chatMobileControlsPointerdownHandler({
      composedPath: () => [document, window],
    } as unknown as Event);

    expect(guardHost.realtimeTalkOptionsOpen).toBe(false);
  });
});
