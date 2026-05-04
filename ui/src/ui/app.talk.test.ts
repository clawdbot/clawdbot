/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { realtimeTalkCtor, startMock, stopMock } = vi.hoisted(() => ({
  realtimeTalkCtor: vi.fn(),
  startMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock("./chat/realtime-talk.ts", () => ({
  RealtimeTalkSession: realtimeTalkCtor,
}));

describe("OpenClawApp Talk controls", () => {
  beforeEach(() => {
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
    const app = new OpenClawApp() as unknown as {
      client: unknown;
      connected: boolean;
      realtimeTalkActive: boolean;
      realtimeTalkStatus: string;
      realtimeTalkSession: { stop(): void } | null;
      sessionKey: string;
      toggleRealtimeTalk(): Promise<void>;
    };
    const staleStop = vi.fn();
    app.client = { request: vi.fn() } as never;
    app.connected = true;
    app.sessionKey = "main";
    app.realtimeTalkActive = true;
    app.realtimeTalkStatus = "error";
    app.realtimeTalkSession = { stop: staleStop };

    await app.toggleRealtimeTalk();

    expect(staleStop).toHaveBeenCalledOnce();
    expect(realtimeTalkCtor).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledOnce();
    expect(stopMock).not.toHaveBeenCalled();
    expect(app.realtimeTalkStatus).toBe("connecting");
    expect(app.realtimeTalkSession).not.toBeNull();
  });
});
