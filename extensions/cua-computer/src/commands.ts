import fs from "node:fs";
import path from "node:path";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createRastermill } from "rastermill";
import { z } from "zod";
import {
  ComputerActParamsSchema,
  normalizeModifiers,
  parseKeyChord,
  scalePoint,
  type ComputerActParams,
} from "./actions.js";
import {
  ClickButton,
  ScrollDirection,
  createCuaDriver,
  type CuaDriverSession,
  type CuaToolResult,
} from "./driver-client.js";
import {
  issueFrame,
  verifyFrame,
  verifyReferenceWidth,
  type CuaDesktopGeometry,
  type CuaFrameState,
  type CuaLastFrame,
  type CuaScreenSize,
} from "./frame.js";

const AVAILABILITY_POLL_MS = 5_000;
// Rastermill enforces inputPixels before resizing, so this must clear the native
// capture, not the delivered frame. 8K (7680x4320 = ~33.2M) is a valid primary
// display; budget above it so full-resolution snapshots reach the downscaler.
const MAX_IMAGE_PIXELS = 40_000_000;

const SnapshotParamsSchema = z.strictObject({
  screenIndex: z.number().int().nonnegative().optional(),
  maxWidth: z.number().int().positive().optional(),
  quality: z.number().finite().optional(),
  format: z.enum(["jpeg", "png"]).optional(),
});

const DesktopStateSchema = z.object({
  platform: z.string().min(1),
  display: z.string().min(1),
  screenshot_width: z.number().int().positive(),
  screenshot_height: z.number().int().positive(),
  screen_width: z.number().int().positive(),
  screen_height: z.number().int().positive(),
  scale_factor: z.number().positive(),
});

const ScreenSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale_factor: z.number().positive(),
});

type ImageProcessor = {
  encode(
    input: Buffer,
    options: {
      format: "jpeg" | "png";
      quality?: number;
      resize?: { width: number; enlarge: false };
    },
  ): Promise<{ data: Buffer; width: number; height: number }>;
};

type CuaComputerCommandsOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  driver?: CuaDriverSession;
  createDriver?: () => CuaDriverSession;
  imageProcessor?: ImageProcessor;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

class PromiseQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function parseParams<T>(schema: z.ZodType<T>, paramsJSON: string | null | undefined): T {
  let value: unknown;
  try {
    value = JSON.parse(paramsJSON ?? "{}");
  } catch {
    throw new Error("COMPUTER_INVALID_REQUEST: params must be valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `COMPUTER_INVALID_REQUEST: ${parsed.error.issues[0]?.message ?? "invalid params"}`,
    );
  }
  return parsed.data;
}

function assertPrimaryDisplay(screenIndex: number | undefined): void {
  if (screenIndex !== undefined && screenIndex !== 0) {
    throw new Error(
      "COMPUTER_UNSUPPORTED_DISPLAY: cua-driver controls only the primary display (screenIndex 0)",
    );
  }
}

function assertToolSuccess(result: CuaToolResult, tool: string): CuaToolResult {
  if (result.isError) {
    const code = result.errorCode
      ? `COMPUTER_REFUSED_${result.errorCode}`
      : "COMPUTER_DRIVER_ERROR";
    throw new Error(`${code}: ${result.text || `${tool} failed`}`);
  }
  return result;
}

function structuredContent(result: CuaToolResult, tool: string): Record<string, unknown> {
  assertToolSuccess(result, tool);
  if (!result.structuredJson) {
    throw new Error(`COMPUTER_DRIVER_ERROR: ${tool} returned no structuredContent`);
  }
  try {
    const value: unknown = JSON.parse(result.structuredJson);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new Error(`COMPUTER_DRIVER_ERROR: ${tool} returned invalid structuredContent`);
}

function desktopGeometry(result: CuaToolResult): CuaDesktopGeometry {
  const parsed = DesktopStateSchema.safeParse(structuredContent(result, "get_desktop_state"));
  if (!parsed.success) {
    throw new Error("COMPUTER_DRIVER_ERROR: invalid get_desktop_state geometry");
  }
  return {
    platform: parsed.data.platform,
    display: parsed.data.display,
    screenWidth: parsed.data.screen_width,
    screenHeight: parsed.data.screen_height,
    scaleFactor: parsed.data.scale_factor,
    screenshotWidth: parsed.data.screenshot_width,
    screenshotHeight: parsed.data.screenshot_height,
  };
}

function desktopPng(result: CuaToolResult): Buffer {
  const image = result.images.find((entry) => entry.mimeType === "image/png");
  if (!image) {
    throw new Error("COMPUTER_DRIVER_ERROR: get_desktop_state returned no PNG image");
  }
  const canonicalPng = canonicalizeBase64(image.dataBase64);
  if (!canonicalPng) {
    throw new Error("COMPUTER_DRIVER_ERROR: get_desktop_state returned malformed PNG base64");
  }
  return Buffer.from(canonicalPng, "base64");
}

function screenSize(result: CuaToolResult): CuaScreenSize {
  const parsed = ScreenSizeSchema.safeParse(structuredContent(result, "get_screen_size"));
  if (!parsed.success) {
    throw new Error("COMPUTER_DRIVER_ERROR: invalid get_screen_size geometry");
  }
  return {
    width: parsed.data.width,
    height: parsed.data.height,
    scaleFactor: parsed.data.scale_factor,
  };
}

function resolveImageCommand(command: string, env: NodeJS.ProcessEnv): string | null {
  const names =
    process.platform === "win32" && !path.extname(command)
      ? [command, `${command}.exe`, `${command}.cmd`]
      : [command];
  for (const entry of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.resolve(entry, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }
  return null;
}

function createImageProcessor(env: NodeJS.ProcessEnv): ImageProcessor {
  return createRastermill({
    execution: "auto",
    limits: { inputPixels: MAX_IMAGE_PIXELS, outputPixels: MAX_IMAGE_PIXELS },
    temp: { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-cua-computer-" },
    commandResolver: (command) => resolveImageCommand(command, env),
  });
}

function clickArgs(
  frame: CuaLastFrame,
  params: ComputerActParams,
  button: ClickButton,
  count: 1 | 2 | 3,
) {
  const point = scalePoint(frame, params.x, params.y, params.action);
  const modifiers = normalizeModifiers(params.modifiers);
  if (modifiers.length > 0) {
    throw new Error(
      "COMPUTER_UNSUPPORTED_ACTION: modifier-held clicks are unsupported by cua-driver on Linux",
    );
  }
  return {
    ...point,
    button,
    count,
  };
}

async function currentFrame(
  driver: CuaDriverSession,
  frameState: CuaFrameState,
  params: ComputerActParams,
  signal?: AbortSignal,
): Promise<CuaLastFrame> {
  const current = screenSize(await driver.getScreenSize(signal));
  if (driver.generation !== frameState.generation) {
    frameState.lastFrame = undefined;
    throw new Error("COMPUTER_STALE_FRAME: the computer driver reconnected; take a new screenshot");
  }
  const frame = verifyFrame(frameState, params.displayFrameId, current);
  verifyReferenceWidth(frameState, frame, params.refWidth);
  return frame;
}

async function handleAct(
  driver: CuaDriverSession,
  frameState: CuaFrameState,
  params: ComputerActParams,
  signal?: AbortSignal,
): Promise<string> {
  assertPrimaryDisplay(params.screenIndex);
  // `wait` never reaches the wire: core sleeps locally and the Swift wire enum
  // has no wait case, so accepting it here would fork the computer.act contract.
  if (
    params.action === "hold_key" ||
    params.action === "left_mouse_down" ||
    params.action === "left_mouse_up"
  ) {
    // Upstream has no desktop keyboard-down API, and its Linux mouse hold tools
    // are window-only, so these actions cannot preserve desktop-scope semantics.
    throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${params.action}`);
  }

  // Every action uses scope:"desktop", a global SendInput/XTest/wayland_desktop
  // injection that is inherently foreground and ignores delivery_mode (that
  // background-vs-foreground contract is window-targeted only). We deliberately
  // never send delivery_mode.
  switch (params.action) {
    case "type": {
      if (!params.text) {
        throw new Error("COMPUTER_INVALID_REQUEST: text is required for type");
      }
      assertToolSuccess(await driver.typeText(params.text, signal), "type_text");
      break;
    }
    case "key": {
      // press_key applies the modifier array on every backend: X11 via XTest,
      // and native Wayland by internally promoting a modifier chord to
      // hotkey_focused. No separate hotkey call is needed for chords.
      const chord = parseKeyChord(params.keys);
      assertToolSuccess(
        await driver.pressKey(
          {
            key: chord.key,
            modifiers: chord.modifiers,
          },
          signal,
        ),
        "press_key",
      );
      break;
    }
    case "scroll": {
      if (!params.scrollDirection) {
        throw new Error("COMPUTER_INVALID_REQUEST: scrollDirection is required for scroll");
      }
      if (normalizeModifiers(params.modifiers).length > 0) {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: modifier-held scroll is unsupported by cua-driver",
        );
      }
      // Desktop-scope scroll requires explicit coordinates, and they must be
      // frame-authorized like clicks. We deliberately do not synthesize a point
      // from get_cursor_position: that mixes cursor and capture coordinate
      // spaces across X11/Wayland/Windows and would scroll an unverified target.
      const frame = await currentFrame(driver, frameState, params, signal);
      const point = scalePoint(frame, params.x, params.y, params.action);
      const direction = {
        up: ScrollDirection.Up,
        down: ScrollDirection.Down,
        left: ScrollDirection.Left,
        right: ScrollDirection.Right,
      }[params.scrollDirection];
      assertToolSuccess(
        await driver.scroll(
          {
            direction,
            // Schema guarantees a positive amount; cap at the driver's max of 50.
            amount: BigInt(Math.min(50, params.scrollAmount ?? 3)),
            ...point,
          },
          signal,
        ),
        "scroll",
      );
      break;
    }
    default: {
      const frame = await currentFrame(driver, frameState, params, signal);
      switch (params.action) {
        case "left_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, params, ClickButton.Left, 1), signal),
            "click",
          );
          break;
        case "right_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, params, ClickButton.Right, 1), signal),
            "click",
          );
          break;
        case "middle_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, params, ClickButton.Middle, 1), signal),
            "click",
          );
          break;
        case "double_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, params, ClickButton.Left, 2), signal),
            "click",
          );
          break;
        case "triple_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, params, ClickButton.Left, 3), signal),
            "click",
          );
          break;
        case "mouse_move": {
          const point = scalePoint(frame, params.x, params.y, params.action);
          assertToolSuccess(await driver.moveCursor(point, signal), "move_cursor");
          break;
        }
        case "left_click_drag": {
          const from = scalePoint(frame, params.fromX, params.fromY, "drag start");
          const to = scalePoint(frame, params.x, params.y, "drag end");
          // The typed desktop drag API has no modifier field. Refuse instead of
          // silently widening a model request into an unmodified drag.
          if (normalizeModifiers(params.modifiers).length > 0) {
            throw new Error(
              "COMPUTER_UNSUPPORTED_ACTION: modifier-held drag is unsupported by cua-driver",
            );
          }
          assertToolSuccess(
            await driver.drag(
              {
                fromX: from.x,
                fromY: from.y,
                toX: to.x,
                toY: to.y,
                // CUA caps desktop drag duration at 10 seconds; clamp rather than
                // rejecting a valid computer.act request at the SDK boundary.
                ...(params.durationMs === undefined
                  ? {}
                  : { durationMs: BigInt(Math.min(10_000, params.durationMs)) }),
              },
              signal,
            ),
            "drag",
          );
          break;
        }
        default:
          throw new Error("COMPUTER_UNSUPPORTED_ACTION: unknown action");
      }
    }
  }
  return JSON.stringify({ ok: true });
}

export function createCuaComputerCommands(
  options: CuaComputerCommandsOptions = {},
): OpenClawPluginNodeHostCommand[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  let ownedDriver: CuaDriverSession | undefined;
  let stopped = false;
  // The node host owns one trusted SDK session for this command execution.
  // It is shared by snapshot/act so a frame can only authorize its paired input.
  const driver = () => {
    if (stopped) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-computer is stopping");
    }
    return options.driver ?? (ownedDriver ??= (options.createDriver ?? createCuaDriver)());
  };
  const disposeOwnedDriver = async () => {
    stopped = true;
    const current = ownedDriver;
    ownedDriver = undefined;
    await current?.dispose();
  };
  const imageProcessor = options.imageProcessor ?? createImageProcessor(env);
  const queue = new PromiseQueue();
  const frameState: CuaFrameState = { generation: "uninitialized" };
  const interval = options.setInterval ?? setInterval;
  const clear = options.clearInterval ?? clearInterval;
  const isSupportedPlatform = platform === "linux" || platform === "win32";
  const isAvailable = () => isSupportedPlatform && driver().isAvailable();

  const snapshot: OpenClawPluginNodeHostCommand = {
    command: "screen.snapshot",
    cap: "screen",
    dangerous: false,
    isAvailable,
    watchAvailability: (_context, onChange) => {
      let knownAvailable = isAvailable();
      const timer = interval(() => {
        driver().resetAvailabilityCache();
        const available = isAvailable();
        if (available !== knownAvailable) {
          knownAvailable = available;
          onChange();
        }
      }, AVAILABILITY_POLL_MS);
      timer.unref?.();
      return () => {
        clear(timer);
        void disposeOwnedDriver();
      };
    },
    handle: async (paramsJSON, _io, context) =>
      await queue.run(async () => {
        if (!isSupportedPlatform) {
          throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-computer supports Windows and Linux");
        }
        const params = parseParams(SnapshotParamsSchema, paramsJSON);
        assertPrimaryDisplay(params.screenIndex);
        const format = params.format ?? "jpeg";
        const maxWidth = params.maxWidth ?? (format === "png" ? 900 : 1_600);
        const quality = Math.min(1, Math.max(0.05, params.quality ?? 0.72));
        const desktop = await driver().getDesktopState(context?.signal);
        const geometry = desktopGeometry(desktop);
        // cua-driver desktop input consumes native get_desktop_state PNG pixels,
        // and on every supported backend the driver reports screen geometry in
        // that same physical-pixel space (Windows PMv2, Linux X11/Wayland). If a
        // capture ever diverges from screen geometry, our screenshot->native
        // scaling would mis-target input, so refuse rather than click blind.
        if (
          geometry.screenWidth !== geometry.screenshotWidth ||
          geometry.screenHeight !== geometry.screenshotHeight
        ) {
          throw new Error(
            "COMPUTER_UNSUPPORTED_DISPLAY: cua-driver reported capture and screen geometry in different pixel spaces",
          );
        }
        const nativePng = desktopPng(desktop);
        let encoded = nativePng;
        let width = geometry.screenshotWidth;
        let height = geometry.screenshotHeight;
        if (format === "jpeg" || width > maxWidth) {
          const result = await imageProcessor.encode(nativePng, {
            format,
            ...(format === "jpeg" ? { quality: Math.round(quality * 100) } : {}),
            ...(width > maxWidth ? { resize: { width: maxWidth, enlarge: false } } : {}),
          });
          encoded = result.data;
          width = result.width;
          height = result.height;
        }
        frameState.generation = driver().generation;
        const displayFrameId = issueFrame(frameState, geometry, { width, height });
        return JSON.stringify({
          format,
          base64: encoded.toString("base64"),
          displayFrameId,
          screenIndex: 0,
          width,
          height,
        });
      }),
  };

  const act: OpenClawPluginNodeHostCommand = {
    command: "computer.act",
    cap: "computer",
    dangerous: true,
    isAvailable,
    handle: async (paramsJSON, _io, context) =>
      await queue.run(async () => {
        if (!isSupportedPlatform) {
          throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-computer supports Windows and Linux");
        }
        return await handleAct(
          driver(),
          frameState,
          parseParams(ComputerActParamsSchema, paramsJSON),
          context?.signal,
        );
      }),
  };

  return [snapshot, act];
}
