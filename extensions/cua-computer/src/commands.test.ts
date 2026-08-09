import { describe, expect, it, vi } from "vitest";
import { createCuaComputerCommands } from "./commands.js";
import {
  ClickButton,
  ScrollDirection,
  type CuaDriverSession,
  type CuaToolResult,
} from "./driver-client.js";

const geometry = {
  platform: "linux",
  display: "primary",
  screenshot_width: 100,
  screenshot_height: 50,
  screen_width: 100,
  screen_height: 50,
  scale_factor: 1,
};

function result(structured: Record<string, unknown>, image = false): CuaToolResult {
  return {
    text: "ok",
    images: image
      ? [{ mimeType: "image/png", dataBase64: Buffer.from("png").toString("base64") }]
      : [],
    structuredJson: JSON.stringify(structured),
    isError: false,
    degraded: false,
    rawJson: "{}",
  };
}

function driver() {
  const getDesktopState = vi.fn(async () => result(geometry, true));
  const getScreenSize = vi.fn(async () => result({ width: 100, height: 50, scale_factor: 1 }));
  const click = vi.fn(async () => result({}));
  const drag = vi.fn(async () => result({}));
  const moveCursor = vi.fn(async () => result({}));
  const scroll = vi.fn(async () => result({}));
  const typeText = vi.fn(async () => result({}));
  const pressKey = vi.fn(async () => result({}));
  const dispose = vi.fn(async () => {});
  const session: CuaDriverSession = {
    generation: "execution-1",
    isAvailable: () => true,
    resetAvailabilityCache: () => {},
    getDesktopState,
    getScreenSize,
    click,
    drag,
    moveCursor,
    scroll,
    typeText,
    pressKey,
    dispose,
  };
  return {
    session,
    getDesktopState,
    getScreenSize,
    click,
    drag,
    moveCursor,
    scroll,
    dispose,
    typeText,
    pressKey,
  };
}

function commands(session: CuaDriverSession) {
  return createCuaComputerCommands({
    platform: "linux",
    driver: session,
    imageProcessor: {
      encode: vi.fn(async () => ({ data: Buffer.from("jpeg"), width: 100, height: 50 })),
    },
  });
}

describe("cua-computer direct SDK commands", () => {
  it("uses one typed session for snapshot and frame-authorized click", async () => {
    const { session, getDesktopState, getScreenSize, click } = driver();
    const [snapshot, act] = commands(session);
    const screen = JSON.parse(await snapshot!.handle('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    await act!.handle(
      JSON.stringify({
        action: "left_click",
        displayFrameId: screen.displayFrameId,
        refWidth: screen.width,
        x: 10,
        y: 20,
      }),
    );
    expect(getDesktopState).toHaveBeenCalledOnce();
    expect(getScreenSize).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledWith(
      {
        x: 10,
        y: 20,
        button: ClickButton.Left,
        count: 1,
      },
      undefined,
    );
  });

  it("maps scroll and key through typed SDK enums", async () => {
    const { session, typeText, pressKey } = driver();
    const [, act] = commands(session);
    await act!.handle('{"action":"type","text":"hello"}');
    await act!.handle('{"action":"key","keys":"ctrl+enter"}');
    expect(typeText).toHaveBeenCalledWith("hello", undefined);
    expect(pressKey).toHaveBeenCalledWith({ key: "enter", modifiers: ["ctrl"] }, undefined);
    expect(ScrollDirection.Down).toBeTypeOf("number");
  });

  it("maps all remaining projected desktop actions through direct SDK methods", async () => {
    const { session, scroll, moveCursor, drag } = driver();
    const [snapshot, act] = commands(session);
    const screen = JSON.parse(await snapshot!.handle('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    const frame = { displayFrameId: screen.displayFrameId, refWidth: screen.width };

    await act!.handle(
      JSON.stringify({
        action: "scroll",
        ...frame,
        x: 10,
        y: 20,
        scrollDirection: "down",
        scrollAmount: 4,
      }),
    );
    await act!.handle(JSON.stringify({ action: "mouse_move", ...frame, x: 11, y: 21 }));
    await act!.handle(
      JSON.stringify({
        action: "left_click_drag",
        ...frame,
        fromX: 12,
        fromY: 22,
        x: 13,
        y: 23,
        durationMs: 500,
      }),
    );

    expect(scroll).toHaveBeenCalledWith(
      { x: 10, y: 20, direction: ScrollDirection.Down, amount: 4n },
      undefined,
    );
    expect(moveCursor).toHaveBeenCalledWith({ x: 11, y: 21 }, undefined);
    expect(drag).toHaveBeenCalledWith(
      { fromX: 12, fromY: 22, toX: 13, toY: 23, durationMs: 500n },
      undefined,
    );
  });

  it("turns a direct SDK refusal into a typed computer error", async () => {
    const { session, click } = driver();
    click.mockResolvedValueOnce({
      ...result({}),
      isError: true,
      errorCode: "desktop_unavailable",
      text: "desktop input is unavailable",
    });
    const [snapshot, act] = commands(session);
    const screen = JSON.parse(await snapshot!.handle('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    await expect(
      act!.handle(
        JSON.stringify({
          action: "left_click",
          displayFrameId: screen.displayFrameId,
          refWidth: screen.width,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_REFUSED_desktop_unavailable");
  });

  it("rejects a mismatched reference width before desktop input", async () => {
    const { session, click } = driver();
    const [snapshot, act] = commands(session);
    const screen = JSON.parse(await snapshot!.handle('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };

    await expect(
      act!.handle(
        JSON.stringify({
          action: "left_click",
          displayFrameId: screen.displayFrameId,
          refWidth: screen.width + 1,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME: the coordinate reference width changed");
    expect(click).not.toHaveBeenCalled();
  });

  it("lazily owns one session and closes it when node-host availability stops", async () => {
    const { session, dispose } = driver();
    const createDriver = vi.fn(() => session);
    const clearInterval = vi.fn();
    const [snapshot] = createCuaComputerCommands({
      platform: "linux",
      createDriver,
      imageProcessor: {
        encode: vi.fn(async () => ({ data: Buffer.from("jpeg"), width: 100, height: 50 })),
      },
      setInterval: vi.fn(() => Object.assign(1, { unref: vi.fn() })) as never,
      clearInterval: clearInterval as never,
    });
    expect(createDriver).not.toHaveBeenCalled();

    await snapshot!.handle('{"format":"png","maxWidth":100}');
    expect(createDriver).toHaveBeenCalledOnce();

    const stop = snapshot!.watchAvailability?.({ config: {} as never, env: {} }, vi.fn());
    stop?.();
    await Promise.resolve();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("passes node invocation cancellation to the direct SDK", async () => {
    const { session, getDesktopState } = driver();
    const [snapshot] = commands(session);
    const signal = AbortSignal.abort();
    await snapshot!.handle('{"format":"png","maxWidth":100}', undefined, {
      sendNodeEvent: vi.fn(),
      signal,
    });
    expect(getDesktopState).toHaveBeenCalledWith(signal);
  });
});
