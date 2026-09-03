import { registerComputerUseProvider } from "openclaw/plugin-sdk/computer-use";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { readImageMetadataFromHeader } from "rastermill";
import { describe, expect, it } from "vitest";
import { createCuaComputerProvider } from "./commands.js";
import { driver, execution, macOsEndpoint, result } from "./commands.test-helpers.js";
import { ClickButton, ScrollDirection } from "./driver-client.js";

describe("cua-computer desktop frames", () => {
  it.each(
    (
      [
        {
          name: "small macOS display",
          platform: "darwin",
          native: [1024, 768],
          scale: 1,
          cap: 1200,
          delivered: [1024, 768],
        },
        {
          name: "downscaled Windows display",
          platform: "win32",
          native: [1920, 1080],
          scale: 1,
          cap: 1280,
          delivered: [1280, 720],
        },
        {
          name: "portrait Linux display",
          platform: "linux",
          native: [1080, 1920],
          scale: 1,
          cap: 1280,
          delivered: [720, 1280],
        },
        {
          name: "macOS Retina display",
          platform: "darwin",
          native: [200, 100],
          scale: 2,
          cap: 100,
          delivered: [100, 50],
        },
        {
          name: "rounded portrait display",
          platform: "win32",
          native: [1201, 1244],
          scale: 1,
          cap: 1200,
          delivered: [1159, 1200],
        },
        {
          name: "one-pixel reference cap",
          platform: "linux",
          native: [64, 160],
          scale: 1,
          cap: 1,
          delivered: [1, 1],
        },
      ] as const
    ).flatMap((test) =>
      (["capture cap", "returned width"] as const).map((reference) =>
        Object.assign({ reference }, test),
      ),
    ),
  )(
    "maps the returned bitmap on a $name using its $reference",
    async ({ platform, native, scale, cap, delivered, reference }) => {
      const geometry = {
        platform: platform === "darwin" ? "macos" : platform,
        display: "primary",
        screenshot_width: native[0],
        screenshot_height: native[1],
        screen_width: native[0] / scale,
        screen_height: native[1] / scale,
        scale_factor: scale,
      };
      const input = driver({ geometry });
      input.getDesktopState.mockResolvedValue({
        ...result(geometry),
        images: [
          {
            mimeType: "image/png",
            dataBase64: createSolidPngBuffer(native[0], native[1], {
              r: 70,
              g: 125,
              b: 180,
            }).toString("base64"),
          },
        ],
      });
      const provider = createCuaComputerProvider({
        platform,
        env: macOsEndpoint(),
        driver: input.session,
      });
      const commands: OpenClawPluginNodeHostCommand[] = [];
      registerComputerUseProvider(
        { registerNodeHostCommand: (command) => commands.push(command) },
        provider,
      );
      const executionId = "123e4567-e89b-42d3-a456-426614174000";
      const invoke = (command: string, params: Record<string, unknown>) =>
        commands
          .find((entry) => entry.command === command)!
          .handle(JSON.stringify({ executionId, ...params }));
      try {
        const screen = JSON.parse(
          await invoke("screen.snapshot", { format: "png", maxWidth: cap }),
        ) as {
          base64: string;
          displayFrameId: string;
          width: number;
          height: number;
        };
        expect([screen.width, screen.height]).toEqual(delivered);
        expect(readImageMetadataFromHeader(Buffer.from(screen.base64, "base64"))).toEqual({
          width: screen.width,
          height: screen.height,
        });
        const frame = {
          displayFrameId: screen.displayFrameId,
          refWidth: reference === "capture cap" ? cap : screen.width,
        };
        const point = { x: screen.width / 2, y: screen.height / 2 };
        const nativePoint = { x: Math.round(native[0] / 2), y: Math.round(native[1] / 2) };

        await invoke("computer.act", { action: "left_click", ...frame, ...point });
        await invoke("computer.act", { action: "mouse_move", ...frame, ...point });
        await invoke("computer.act", {
          action: "scroll",
          ...frame,
          ...point,
          scrollDirection: "down",
          scrollAmount: 4,
        });
        await invoke("computer.act", {
          action: "left_click_drag",
          ...frame,
          fromX: 0,
          fromY: 0,
          ...point,
        });

        expect(input.click).toHaveBeenCalledExactlyOnceWith(
          { ...nativePoint, button: ClickButton.Left, count: 1 },
          undefined,
        );
        expect(input.moveCursor).toHaveBeenCalledExactlyOnceWith(nativePoint, undefined);
        expect(input.scroll).toHaveBeenCalledExactlyOnceWith(
          { ...nativePoint, direction: ScrollDirection.Down, amount: 4n },
          undefined,
        );
        expect(input.drag).toHaveBeenCalledExactlyOnceWith(
          { fromX: 0, fromY: 0, toX: nativePoint.x, toY: nativePoint.y },
          undefined,
        );
        for (const [x, y] of [
          [delivered[0], 0],
          [0, delivered[1]],
        ]) {
          await expect(
            invoke("computer.act", { action: "left_click", ...frame, x, y }),
          ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
        }
        expect(input.click).toHaveBeenCalledOnce();
      } finally {
        await invoke("computer.act", { action: "__close_execution", reason: "completion" });
      }
    },
  );

  it("uses one typed session for snapshot and frame-authorized click", async () => {
    const { session, getDesktopState, getScreenSize, click } = driver();
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    await computer.act(
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
    const computer = await execution(session);
    await computer.act('{"action":"type","text":"hello"}');
    await computer.act('{"action":"key","keys":"ctrl+enter"}');
    expect(typeText).toHaveBeenCalledWith("hello", undefined);
    expect(pressKey).toHaveBeenCalledWith({ key: "enter", modifiers: ["ctrl"] }, undefined);
    expect(ScrollDirection.Down).toBeTypeOf("number");
  });

  it("maps all remaining projected desktop actions through direct SDK methods", async () => {
    const { session, scroll, moveCursor, drag } = driver();
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    const frame = { displayFrameId: screen.displayFrameId, refWidth: screen.width };

    await computer.act(
      JSON.stringify({
        action: "scroll",
        ...frame,
        x: 10,
        y: 20,
        scrollDirection: "down",
        scrollAmount: 4,
      }),
    );
    await computer.act(JSON.stringify({ action: "mouse_move", ...frame, x: 11, y: 21 }));
    await computer.act(
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
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    await expect(
      computer.act(
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
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };

    await expect(
      computer.act(
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

  it.each([
    "forged frame",
    "superseded capture scale",
    "changed display geometry",
    "reconnected driver",
  ])("rejects a %s before desktop input", async (cause) => {
    const { session, click, getDesktopState, getScreenSize, setGeneration } = driver();
    const desktop = await getDesktopState();
    desktop.images = [
      {
        mimeType: "image/png",
        dataBase64: createSolidPngBuffer(100, 50, { r: 70, g: 125, b: 180 }).toString("base64"),
      },
    ];
    getDesktopState.mockResolvedValue(desktop);
    const computer = await createCuaComputerProvider({
      platform: "linux",
      driver: session,
    }).openExecution({ executionId: "123e4567-e89b-42d3-a456-426614174000" });
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
    };
    const action = {
      action: "left_click",
      displayFrameId: screen.displayFrameId,
      refWidth: 100,
      x: 10,
      y: 20,
    };
    switch (cause) {
      case "forged frame":
        action.displayFrameId = "cua:v1:forged";
        break;
      case "superseded capture scale":
        await computer.snapshot('{"format":"png","maxWidth":50}');
        action.refWidth = 50;
        break;
      case "changed display geometry":
        getScreenSize.mockResolvedValue(result({ width: 101, height: 50, scale_factor: 1 }));
        break;
      case "reconnected driver":
        setGeneration("execution-2");
        break;
    }
    await expect(computer.act(JSON.stringify(action))).rejects.toThrow("COMPUTER_STALE_FRAME");
    expect(click).not.toHaveBeenCalled();
    await computer.close("completion");
  });
});
