import { describe, expect, it, vi } from "vitest";
import { createCuaComputerCommands } from "./commands.js";
import type { CuaDriver, CuaToolResult } from "./driver-client.js";

type ToolCall = { name: string; args: Record<string, unknown> };

function desktopResult(overrides: Record<string, unknown> = {}): CuaToolResult {
  return {
    content: [
      { type: "image", data: Buffer.from("native-png").toString("base64"), mimeType: "image/png" },
      { type: "text", text: "desktop" },
    ],
    structuredContent: {
      platform: "linux",
      display: "primary",
      screenshot_width: 3840,
      screenshot_height: 2160,
      screen_width: 3840,
      screen_height: 2160,
      scale_factor: 1,
      ...overrides,
    },
  };
}

function screenSizeResult(overrides: Record<string, unknown> = {}): CuaToolResult {
  return {
    content: [{ type: "text", text: "size" }],
    structuredContent: { width: 3840, height: 2160, scale_factor: 1, ...overrides },
  };
}

function createDriver(
  options: {
    desktop?: () => CuaToolResult;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<CuaToolResult>;
    available?: boolean;
    generation?: () => number;
  } = {},
) {
  const calls: ToolCall[] = [];
  const driver: CuaDriver = {
    get generation() {
      return options.generation?.() ?? 1;
    },
    isAvailable: () => options.available ?? true,
    resetAvailabilityCache: vi.fn(),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (options.callTool) {
        return await options.callTool(name, args);
      }
      if (name === "get_desktop_state") {
        return options.desktop?.() ?? desktopResult();
      }
      if (name === "get_screen_size") {
        return screenSizeResult();
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    dispose: vi.fn(async () => {}),
  };
  return { driver, calls };
}

function createProcessor() {
  const encode = vi.fn(
    async (
      _input: Buffer,
      options: { format: "jpeg" | "png"; quality?: number; resize?: { width: number } },
    ) => ({
      data: Buffer.from(`${options.format}-encoded`),
      width: options.resize?.width ?? 3840,
      height: options.resize ? Math.round((2160 * options.resize.width) / 3840) : 2160,
    }),
  );
  return { processor: { encode }, encode };
}

function commandSet(
  driver: CuaDriver,
  imageProcessor = createProcessor().processor,
  platform: NodeJS.Platform = "linux",
) {
  const commands = createCuaComputerCommands({ platform, driver, imageProcessor });
  const snapshot = commands.find((command) => command.command === "screen.snapshot");
  const act = commands.find((command) => command.command === "computer.act");
  if (!snapshot || !act) {
    throw new Error("commands missing");
  }
  return { snapshot, act };
}

async function issueFrameFor(driver: CuaDriver, platform: NodeJS.Platform = "linux") {
  const { snapshot, act } = commandSet(driver, createProcessor().processor, platform);
  const payload = JSON.parse(
    await snapshot.handle(JSON.stringify({ maxWidth: 1920, format: "jpeg" })),
  ) as { displayFrameId: string; width: number };
  return { act, frameId: payload.displayFrameId, refWidth: payload.width };
}

describe("cua-computer screen.snapshot", () => {
  it("scales native screenshots to maxWidth and returns delivered dimensions", async () => {
    const { driver } = createDriver();
    const { processor, encode } = createProcessor();
    const { snapshot } = commandSet(driver, processor);

    const payload = JSON.parse(
      await snapshot.handle(JSON.stringify({ maxWidth: 1456, quality: 0.61, format: "jpeg" })),
    ) as Record<string, unknown>;

    expect(payload).toMatchObject({ format: "jpeg", screenIndex: 0, width: 1456, height: 819 });
    expect(payload.displayFrameId).toMatch(/^cua:v1:[a-f0-9]{64}$/);
    expect(encode).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        format: "jpeg",
        quality: 61,
        resize: { width: 1456, enlarge: false },
      }),
    );
  });

  it.each(["png", "jpeg"] as const)("encodes %s snapshots", async (format) => {
    const { driver } = createDriver();
    const { processor, encode } = createProcessor();
    const { snapshot } = commandSet(driver, processor);

    const payload = JSON.parse(
      await snapshot.handle(JSON.stringify({ maxWidth: 2000, format })),
    ) as { format: string; base64: string };

    expect(payload.format).toBe(format);
    expect(Buffer.from(payload.base64, "base64").toString()).toBe(`${format}-encoded`);
    expect(encode).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ format }));
  });

  it("returns the native PNG without re-encoding when no resize is needed", async () => {
    const { driver } = createDriver();
    const { processor, encode } = createProcessor();
    const { snapshot } = commandSet(driver, processor);

    const payload = JSON.parse(
      await snapshot.handle(JSON.stringify({ maxWidth: 4000, format: "png" })),
    ) as { base64: string; width: number; height: number };

    expect(Buffer.from(payload.base64, "base64").toString()).toBe("native-png");
    expect(payload).toMatchObject({ width: 3840, height: 2160 });
    expect(encode).not.toHaveBeenCalled();
  });

  it("rejects non-primary screen indexes", async () => {
    const { driver } = createDriver();
    const { snapshot } = commandSet(driver);
    await expect(snapshot.handle('{"screenIndex":1}')).rejects.toThrow(
      "COMPUTER_UNSUPPORTED_DISPLAY",
    );
  });

  it("refuses capture when screen and screenshot geometry differ", async () => {
    // Guards the scalePoint invariant: input is native-pixel, so a capture whose
    // screen geometry differs from its screenshot pixels would mis-target.
    const { driver } = createDriver({
      desktop: () => desktopResult({ screen_width: 2560, screen_height: 1440 }),
    });
    const { snapshot } = commandSet(driver);
    await expect(snapshot.handle("{}")).rejects.toThrow(
      "COMPUTER_UNSUPPORTED_DISPLAY: cua-driver reported capture and screen geometry",
    );
  });

  it("rotates the frame token when captured display geometry changes", async () => {
    let width = 3840;
    const { driver } = createDriver({
      desktop: () =>
        desktopResult({
          screenshot_width: width,
          screen_width: width,
        }),
    });
    const { snapshot } = commandSet(driver);
    const first = JSON.parse(await snapshot.handle('{"format":"png","maxWidth":4000}')) as {
      displayFrameId: string;
    };
    width = 2560;
    const second = JSON.parse(await snapshot.handle('{"format":"png","maxWidth":4000}')) as {
      displayFrameId: string;
    };
    expect(second.displayFrameId).not.toBe(first.displayFrameId);
  });
});

describe("cua-computer computer.act", () => {
  it("maps all supported pointer actions to desktop-scope driver calls", async () => {
    const { driver, calls } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);
    calls.length = 0;
    const base = { displayFrameId: frameId, refWidth, x: 960, y: 540 };
    const cases = [
      ["left_click", "click", { x: 1920, y: 1080, button: "left", count: 1 }],
      ["right_click", "click", { x: 1920, y: 1080, button: "right", count: 1 }],
      ["middle_click", "click", { x: 1920, y: 1080, button: "middle", count: 1 }],
      ["double_click", "click", { x: 1920, y: 1080, button: "left", count: 2 }],
      ["triple_click", "click", { x: 1920, y: 1080, button: "left", count: 3 }],
      ["mouse_move", "move_cursor", { x: 1920, y: 1080 }],
      ["left_click_drag", "drag", { from_x: 200, from_y: 400, to_x: 1920, to_y: 1080 }],
      ["scroll", "scroll", { x: 1920, y: 1080, direction: "down", amount: 50, by: "line" }],
    ] as const;

    for (const [action, tool, expected] of cases) {
      await act.handle(
        JSON.stringify({
          action,
          ...base,
          ...(action === "left_click_drag" ? { fromX: 100, fromY: 200 } : {}),
          ...(action === "scroll" ? { scrollDirection: "down", scrollAmount: 99 } : {}),
        }),
      );
      const call = calls.at(-1);
      expect(call?.name).toBe(tool);
      expect(call?.args).toMatchObject({ ...expected, scope: "desktop" });
    }
  });

  it("normalizes click modifiers and keyboard chords", async () => {
    const { driver, calls } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver, "win32");
    calls.length = 0;

    await act.handle(
      JSON.stringify({
        action: "left_click",
        displayFrameId: frameId,
        refWidth,
        x: 10,
        y: 20,
        modifiers: "cmd+Control",
      }),
    );
    await act.handle(JSON.stringify({ action: "key", keys: "super+shift+Return" }));

    expect(calls.find((call) => call.name === "click")?.args).toMatchObject({
      modifier: ["meta", "ctrl"],
    });
    expect(calls.find((call) => call.name === "press_key")?.args).toEqual({
      key: "enter",
      modifiers: ["meta", "shift"],
      scope: "desktop",
    });
  });

  it("maps type without geometry calls and rejects the wire-less wait action", async () => {
    const { driver, calls } = createDriver();
    const { act } = commandSet(driver);

    await act.handle(JSON.stringify({ action: "type", text: "hello" }));
    // Core sleeps locally for wait and never sends it over the wire; the
    // fulfiller must reject it so the computer.act contract stays uniform.
    await expect(act.handle(JSON.stringify({ action: "wait", durationMs: 25 }))).rejects.toThrow(
      /COMPUTER_INVALID_REQUEST/,
    );

    expect(calls).toEqual([{ name: "type_text", args: { text: "hello", scope: "desktop" } }]);
  });

  it("scrolls at frame-authorized coordinates", async () => {
    const { driver, calls } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);

    await act.handle(
      JSON.stringify({
        action: "scroll",
        scrollDirection: "up",
        scrollAmount: 2,
        displayFrameId: frameId,
        refWidth,
        x: 960,
        y: 540,
      }),
    );

    expect(calls.at(-1)).toEqual({
      name: "scroll",
      args: { direction: "up", amount: 2, by: "line", x: 1920, y: 1080, scope: "desktop" },
    });
  });

  it("rejects coordinate-less scroll instead of guessing the cursor point", async () => {
    const { driver, calls } = createDriver();
    const { act } = commandSet(driver);

    await expect(
      act.handle(JSON.stringify({ action: "scroll", scrollDirection: "up", scrollAmount: 2 })),
    ).rejects.toThrow("COMPUTER_STALE_FRAME");
    expect(calls.some((call) => call.name === "get_cursor_position")).toBe(false);
  });

  it.each([0, -3])("rejects non-positive scroll amount %s instead of scrolling", async (amount) => {
    const { driver, calls } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);
    await expect(
      act.handle(
        JSON.stringify({
          action: "scroll",
          scrollDirection: "up",
          scrollAmount: amount,
          displayFrameId: frameId,
          refWidth,
          x: 10,
          y: 10,
        }),
      ),
    ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
    expect(calls.some((call) => call.name === "scroll")).toBe(false);
  });

  it("performs an unmodified drag with scaled coordinates", async () => {
    const { driver, calls } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);

    await act.handle(
      JSON.stringify({
        action: "left_click_drag",
        displayFrameId: frameId,
        refWidth,
        fromX: 0,
        fromY: 0,
        x: 960,
        y: 540,
      }),
    );

    expect(calls.at(-1)).toEqual({
      name: "drag",
      args: { from_x: 0, from_y: 0, to_x: 1920, to_y: 1080, scope: "desktop" },
    });
  });

  it("clamps drag duration to the driver's supported maximum", async () => {
    const { driver, calls } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);

    await act.handle(
      JSON.stringify({
        action: "left_click_drag",
        displayFrameId: frameId,
        refWidth,
        fromX: 0,
        fromY: 0,
        x: 960,
        y: 540,
        durationMs: 15_000,
      }),
    );

    expect(calls.at(-1)).toEqual({
      name: "drag",
      args: { from_x: 0, from_y: 0, to_x: 1920, to_y: 1080, scope: "desktop", duration_ms: 10_000 },
    });
  });

  it("rejects modifier-held drags that cua-driver silently drops", async () => {
    const { driver } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);

    await expect(
      act.handle(
        JSON.stringify({
          action: "left_click_drag",
          displayFrameId: frameId,
          refWidth,
          fromX: 0,
          fromY: 0,
          x: 960,
          y: 540,
          modifiers: "shift",
        }),
      ),
    ).rejects.toThrow("modifier-held drag is unsupported");
  });

  it("rejects modifier actions that cua-driver cannot preserve", async () => {
    const { driver } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);
    await expect(
      act.handle(
        JSON.stringify({
          action: "left_click",
          displayFrameId: frameId,
          refWidth,
          x: 1,
          y: 1,
          modifiers: "shift",
        }),
      ),
    ).rejects.toThrow("modifier-held clicks are unsupported");
    await expect(
      act.handle(JSON.stringify({ action: "scroll", scrollDirection: "down", modifiers: "ctrl" })),
    ).rejects.toThrow("modifier-held scroll is unsupported");
  });

  it.each(["hold_key", "left_mouse_down", "left_mouse_up"])(
    "rejects unsupported %s",
    async (action) => {
      const { driver } = createDriver();
      const { act } = commandSet(driver);
      await expect(act.handle(JSON.stringify({ action }))).rejects.toThrow(
        `COMPUTER_UNSUPPORTED_ACTION: ${action}`,
      );
    },
  );

  it("rejects wrong ids, geometry drift, and reference-width drift", async () => {
    let currentSize = screenSizeResult();
    const { driver } = createDriver({
      callTool: async (name) => {
        if (name === "get_desktop_state") {
          return desktopResult();
        }
        if (name === "get_screen_size") {
          return currentSize;
        }
        return { content: [] };
      },
    });

    const wrong = await issueFrameFor(driver);
    await expect(
      wrong.act.handle(
        JSON.stringify({
          action: "left_click",
          displayFrameId: "cua:v1:wrong",
          refWidth: wrong.refWidth,
          x: 1,
          y: 1,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME");

    const drift = await issueFrameFor(driver);
    currentSize = screenSizeResult({ width: 2560 });
    await expect(
      drift.act.handle(
        JSON.stringify({
          action: "mouse_move",
          displayFrameId: drift.frameId,
          refWidth: drift.refWidth,
          x: 1,
          y: 1,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME");

    currentSize = screenSizeResult();
    const width = await issueFrameFor(driver);
    await expect(
      width.act.handle(
        JSON.stringify({
          action: "mouse_move",
          displayFrameId: width.frameId,
          refWidth: width.refWidth + 1,
          x: 1,
          y: 1,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME");

    const missing = await issueFrameFor(driver);
    await expect(
      missing.act.handle(
        JSON.stringify({
          action: "mouse_move",
          displayFrameId: missing.frameId,
          x: 1,
          y: 1,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME");
  });

  it("rejects frames across driver reconnects", async () => {
    let generation = 1;
    const { driver } = createDriver({
      generation: () => generation,
      callTool: async (name) => {
        if (name === "get_desktop_state") {
          return desktopResult();
        }
        if (name === "get_screen_size") {
          generation = 2;
          return screenSizeResult();
        }
        return { content: [] };
      },
    });
    const { act, frameId, refWidth } = await issueFrameFor(driver);
    await expect(
      act.handle(
        JSON.stringify({ action: "mouse_move", displayFrameId: frameId, refWidth, x: 1, y: 1 }),
      ),
    ).rejects.toThrow("the computer driver reconnected");
  });

  it("rejects coordinates outside the delivered primary-display frame", async () => {
    const { driver } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);
    await expect(
      act.handle(
        JSON.stringify({
          action: "left_click",
          displayFrameId: frameId,
          refWidth,
          x: refWidth,
          y: 0,
        }),
      ),
    ).rejects.toThrow("outside the captured primary-display frame");
  });

  it("preserves structured driver refusal errors", async () => {
    const { driver } = createDriver({
      callTool: async (name) => {
        if (name === "get_desktop_state") {
          return desktopResult();
        }
        if (name === "get_screen_size") {
          return screenSizeResult();
        }
        throw new Error("COMPUTER_REFUSED_background_unavailable: desktop unavailable");
      },
    });
    const { act, frameId, refWidth } = await issueFrameFor(driver);
    await expect(
      act.handle(
        JSON.stringify({ action: "left_click", displayFrameId: frameId, refWidth, x: 1, y: 1 }),
      ),
    ).rejects.toThrow("COMPUTER_REFUSED_background_unavailable");
  });

  it("serializes interleaved action calls", async () => {
    let releaseFirst = () => {};
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const { driver } = createDriver({
      callTool: async (name, args) => {
        if (name === "type_text") {
          started.push(String(args.text));
          if (args.text === "first") {
            await firstPending;
          }
        }
        return { content: [] };
      },
    });
    const { act } = commandSet(driver);

    const first = act.handle(JSON.stringify({ action: "type", text: "first" }));
    const second = act.handle(JSON.stringify({ action: "type", text: "second" }));
    await vi.waitFor(() => expect(started).toEqual(["first"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["first", "second"]);
  });

  it("rejects unknown key and modifier names", async () => {
    const { driver } = createDriver();
    const { act, frameId, refWidth } = await issueFrameFor(driver);
    await expect(act.handle(JSON.stringify({ action: "key", keys: "hyper+x" }))).rejects.toThrow(
      "COMPUTER_UNSUPPORTED_KEY",
    );
    await expect(
      act.handle(
        JSON.stringify({
          action: "left_click",
          displayFrameId: frameId,
          refWidth,
          x: 1,
          y: 1,
          modifiers: "hyper",
        }),
      ),
    ).rejects.toThrow("COMPUTER_UNSUPPORTED_KEY");
  });
});

describe("cua-computer availability", () => {
  it.each([
    ["darwin", true, false],
    ["linux", true, true],
    ["linux", false, false],
  ] as const)("returns %s availability with binary=%s", (platform, binary, expected) => {
    const { driver } = createDriver({ available: binary });
    const command = createCuaComputerCommands({
      platform,
      driver,
      imageProcessor: createProcessor().processor,
    })[0];
    expect(command?.isAvailable?.({ config: {}, env: {} })).toBe(expected);
  });
});
