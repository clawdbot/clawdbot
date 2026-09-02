import fs from "node:fs";
import path from "node:path";
import {
  COMPUTER_USE_V2_ACTION_NAMES,
  parseComputerActParamsJSON,
  parseScreenSnapshotParamsJSON,
  type ComputerActParams,
  type ComputerUseProvider,
} from "openclaw/plugin-sdk/computer-use";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createRastermill } from "rastermill";
import { z } from "zod";
import { normalizeModifiers, parseKeyChord, scalePoint } from "./actions.js";
import {
  ClickButton,
  ScrollDirection,
  createCuaDriver,
  type CuaDriverSession,
  type CuaToolResult,
} from "./driver-client.js";
import { platformActions } from "./driver-result.js";
import { createLazyCuaExecutionResources } from "./execution-resources.js";
import {
  adoptGeneration,
  issueFrame,
  verifyFrame,
  type CuaDesktopGeometry,
  type CuaFrameState,
  type CuaLastFrame,
  type CuaScreenSize,
} from "./frame.js";
import { createCuaMcpDriver } from "./mcp-driver-client.js";
import { closeRecordingExecution } from "./recording-actions.js";
import { handleWindowAct, type CuaComputerActParams } from "./window-actions.js";

const AVAILABILITY_POLL_MS = 5_000;
const CUA_WIRE_ACTION_NAMES = COMPUTER_USE_V2_ACTION_NAMES.slice(1, 14);
// Rastermill enforces inputPixels before resizing, so this must clear the native
// capture, not the delivered frame. 8K (7680x4320 = ~33.2M) is a valid primary
// display; budget above it so full-resolution snapshots reach the downscaler.
const MAX_IMAGE_PIXELS = 40_000_000;
const CUA_DRIVER_ENDPOINT_ENV = "OPENCLAW_CUA_DRIVER_ENDPOINT";

const CuaDriverEndpointSchema = z.strictObject({
  v: z.literal(1),
  socketPath: z.string(),
  binaryPath: z.string(),
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
      resize?: { maxSide: number; enlarge: false };
    },
  ): Promise<{ data: Buffer; width: number; height: number }>;
};

type CuaComputerProviderOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  driver?: CuaDriverSession;
  createDriver?: () => CuaDriverSession;
  imageProcessor?: ImageProcessor;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

function resolveMacOsMcpEndpoint(
  env: NodeJS.ProcessEnv,
): { socketPath: string; binaryPath: string } | undefined {
  const rawEndpoint = env[CUA_DRIVER_ENDPOINT_ENV];
  if (!rawEndpoint || Buffer.byteLength(rawEndpoint, "utf8") > 4 * 1024) {
    return undefined;
  }
  try {
    const rawValue: unknown = JSON.parse(rawEndpoint);
    const parsed = CuaDriverEndpointSchema.safeParse(rawValue);
    if (!parsed.success) {
      return undefined;
    }
    const { socketPath, binaryPath } = parsed.data;
    if (
      socketPath.includes("\0") ||
      binaryPath.includes("\0") ||
      !path.isAbsolute(socketPath) ||
      !path.isAbsolute(binaryPath)
    ) {
      return undefined;
    }
    fs.accessSync(binaryPath, fs.constants.X_OK);
    return { socketPath, binaryPath };
  } catch {
    return undefined;
  }
}

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
  params: CuaComputerActParams,
  button: ClickButton,
  count: 1 | 2 | 3,
) {
  const point = scalePoint(frame, params.x, params.y, params.action);
  const modifiers = normalizeModifiers(params.modifiers);
  if (modifiers.length > 0) {
    throw new Error(
      "COMPUTER_UNSUPPORTED_ACTION: modifier-held desktop clicks are unsupported by cua-driver",
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
  params: CuaComputerActParams,
  signal?: AbortSignal,
): Promise<CuaLastFrame> {
  const current = screenSize(await driver.getScreenSize(signal));
  if (driver.generation !== frameState.generation) {
    frameState.lastFrame = undefined;
    throw new Error("COMPUTER_STALE_FRAME: the computer driver reconnected; take a new screenshot");
  }
  return verifyFrame(frameState, params.displayFrameId, current, params.refWidth);
}

async function handleDesktopAct(
  driver: CuaDriverSession,
  frameState: CuaFrameState,
  params: ComputerActParams,
  signal?: AbortSignal,
): Promise<string> {
  if (!(CUA_WIRE_ACTION_NAMES as readonly string[]).includes(params.action)) {
    throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${params.action}`);
  }
  const desktopParams = params as CuaComputerActParams;
  assertPrimaryDisplay(desktopParams.screenIndex);
  // `wait` never reaches the wire: core sleeps locally and the Swift wire enum
  // has no wait case, so accepting it here would fork the computer.act contract.
  if (
    desktopParams.action === "hold_key" ||
    desktopParams.action === "left_mouse_down" ||
    desktopParams.action === "left_mouse_up"
  ) {
    // Upstream has no desktop keyboard-down API, and its Linux mouse hold tools
    // are window-only, so these actions cannot preserve desktop-scope semantics.
    throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${desktopParams.action}`);
  }

  // Every action targets the primary desktop, a global SendInput/XTest/wayland_desktop
  // injection that is inherently foreground and ignores delivery_mode (that
  // background-vs-foreground contract is window-targeted only). We deliberately
  // never send delivery_mode.
  switch (desktopParams.action) {
    case "type": {
      if (!desktopParams.text) {
        throw new Error("COMPUTER_INVALID_REQUEST: text is required for type");
      }
      assertToolSuccess(await driver.typeText(desktopParams.text, signal), "type_text");
      break;
    }
    case "key": {
      // press_key applies the modifier array on every backend: X11 via XTest,
      // and native Wayland by internally promoting a modifier chord to
      // hotkey_focused. No separate hotkey call is needed for chords.
      const chord = parseKeyChord(desktopParams.keys);
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
      if (!desktopParams.scrollDirection) {
        throw new Error("COMPUTER_INVALID_REQUEST: scrollDirection is required for scroll");
      }
      if (normalizeModifiers(desktopParams.modifiers).length > 0) {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: modifier-held scroll is unsupported by cua-driver",
        );
      }
      // Desktop-scope scroll requires explicit coordinates, and they must be
      // frame-authorized like clicks. We deliberately do not synthesize a point
      // from get_cursor_position: that mixes cursor and capture coordinate
      // spaces across X11/Wayland/Windows and would scroll an unverified target.
      const frame = await currentFrame(driver, frameState, desktopParams, signal);
      const point = scalePoint(frame, desktopParams.x, desktopParams.y, desktopParams.action);
      const direction = {
        up: ScrollDirection.Up,
        down: ScrollDirection.Down,
        left: ScrollDirection.Left,
        right: ScrollDirection.Right,
      }[desktopParams.scrollDirection];
      assertToolSuccess(
        await driver.scroll(
          {
            direction,
            // Schema guarantees a positive amount; cap at the driver's max of 50.
            amount: BigInt(Math.min(50, desktopParams.scrollAmount ?? 3)),
            ...point,
          },
          signal,
        ),
        "scroll",
      );
      break;
    }
    default: {
      const frame = await currentFrame(driver, frameState, desktopParams, signal);
      switch (desktopParams.action) {
        case "left_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, desktopParams, ClickButton.Left, 1), signal),
            "click",
          );
          break;
        case "right_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, desktopParams, ClickButton.Right, 1), signal),
            "click",
          );
          break;
        case "middle_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, desktopParams, ClickButton.Middle, 1), signal),
            "click",
          );
          break;
        case "double_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, desktopParams, ClickButton.Left, 2), signal),
            "click",
          );
          break;
        case "triple_click":
          assertToolSuccess(
            await driver.click(clickArgs(frame, desktopParams, ClickButton.Left, 3), signal),
            "click",
          );
          break;
        case "mouse_move": {
          const point = scalePoint(frame, desktopParams.x, desktopParams.y, desktopParams.action);
          assertToolSuccess(await driver.moveCursor(point, signal), "move_cursor");
          break;
        }
        case "left_click_drag": {
          const from = scalePoint(frame, desktopParams.fromX, desktopParams.fromY, "drag start");
          const to = scalePoint(frame, desktopParams.x, desktopParams.y, "drag end");
          // The typed desktop drag API has no modifier field. Refuse instead of
          // silently widening a model request into an unmodified drag.
          if (normalizeModifiers(desktopParams.modifiers).length > 0) {
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
                ...(desktopParams.durationMs === undefined
                  ? {}
                  : { durationMs: BigInt(Math.min(10_000, desktopParams.durationMs)) }),
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

export function createCuaComputerProvider(
  options: CuaComputerProviderOptions = {},
): ComputerUseProvider {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const macOsEndpoint = platform === "darwin" ? resolveMacOsMcpEndpoint(env) : undefined;
  let ownedAvailabilityDriver: CuaDriverSession | undefined;
  let stopped = false;
  const createDriver =
    options.createDriver ??
    (macOsEndpoint ? () => createCuaMcpDriver({ ...macOsEndpoint, env }) : createCuaDriver);
  const availabilityDriver = () => {
    if (stopped) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-computer is stopping");
    }
    return options.driver ?? (ownedAvailabilityDriver ??= createDriver());
  };
  const disposeAvailabilityDriver = async () => {
    stopped = true;
    const current = ownedAvailabilityDriver;
    ownedAvailabilityDriver = undefined;
    await current?.dispose();
  };
  const imageProcessor = options.imageProcessor ?? createImageProcessor(env);
  const interval = options.setInterval ?? setInterval;
  const clear = options.clearInterval ?? clearInterval;
  const isSupportedPlatform =
    platform === "linux" || platform === "win32" || macOsEndpoint !== undefined;
  // The app injects the endpoint only after the host-owned daemon socket is
  // accepting connections. Node-host manifests are one-shot, so the validated
  // endpoint is the synchronous macOS readiness lease; invocation still
  // awaits the MCP initialize handshake and fails visibly if it cannot attach.
  const isAvailable = () =>
    macOsEndpoint !== undefined || (isSupportedPlatform && availabilityDriver().isAvailable());

  return {
    id: "cua-computer",
    label: "CUA Computer",
    capabilities: () => ({
      contractVersion: 2,
      provider: {
        id: "cua-computer",
        label: "CUA Computer",
        generation: isSupportedPlatform
          ? `cua-computer-v2:${availabilityDriver().generation}`
          : "cua-computer-v2:unsupported",
      },
      actions: platformActions(platform),
      targets: ["screen", "window", "element", "browser"],
      deliveryModes: ["background", "foreground"],
      observations: ["image", "accessibility", "browser"],
      features: { recording: true, agentCursor: false, multiDisplay: false },
    }),
    isAvailable,
    prepare: async () => {
      if (isSupportedPlatform && macOsEndpoint === undefined && !stopped) {
        await availabilityDriver().prepareAvailability?.();
      }
    },
    watchAvailability: (_context, onChange) => {
      let knownAvailable = isAvailable();
      const timer = interval(() => {
        availabilityDriver().resetAvailabilityCache();
        const available = isAvailable();
        if (available !== knownAvailable) {
          knownAvailable = available;
          onChange();
        }
      }, AVAILABILITY_POLL_MS);
      timer.unref?.();
      return () => {
        clear(timer);
        void disposeAvailabilityDriver();
      };
    },
    openExecution: async () => {
      if (stopped) {
        throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-computer is stopping");
      }
      const executionDriver = options.driver ?? createDriver();
      const resources = createLazyCuaExecutionResources();
      const executionState = { resources, recording: {} };
      const queue = new PromiseQueue();
      const frameState: CuaFrameState = { generation: executionDriver.generation };
      let closing = false;
      let closePromise: Promise<void> | undefined;
      const assertOpen = () => {
        if (closing) {
          throw new Error("COMPUTER_DRIVER_UNAVAILABLE: provider execution is closing");
        }
      };
      return {
        snapshot: async (paramsJSON, signal) =>
          await queue.run(async () => {
            assertOpen();
            if (!isSupportedPlatform) {
              throw new Error(
                platform === "darwin"
                  ? `COMPUTER_DRIVER_UNAVAILABLE: cua-computer requires app-provided ${CUA_DRIVER_ENDPOINT_ENV}`
                  : "COMPUTER_DRIVER_UNAVAILABLE: cua-computer supports macOS, Windows, and Linux",
              );
            }
            const params = parseScreenSnapshotParamsJSON(paramsJSON);
            assertPrimaryDisplay(params.screenIndex);
            const format = params.format ?? "jpeg";
            const maxWidth = params.maxWidth ?? (format === "png" ? 900 : 1_600);
            const quality = Math.min(1, Math.max(0.05, params.quality ?? 0.72));
            const desktop = await executionDriver.getDesktopState(signal);
            const geometry = desktopGeometry(desktop);
            // Windows and Linux report capture and input geometry in the same
            // physical-pixel space. macOS intentionally reports logical screen
            // points plus native Retina pixels; its desktop tools consume the
            // native screenshot coordinates and undo that scale internally.
            if (
              platform !== "darwin" &&
              (geometry.screenWidth !== geometry.screenshotWidth ||
                geometry.screenHeight !== geometry.screenshotHeight)
            ) {
              throw new Error(
                "COMPUTER_UNSUPPORTED_DISPLAY: cua-driver reported capture and screen geometry in different pixel spaces",
              );
            }
            const nativePng = desktopPng(desktop);
            let encoded = nativePng;
            let width = geometry.screenshotWidth;
            let height = geometry.screenshotHeight;
            if (format === "jpeg" || Math.max(width, height) > maxWidth) {
              const result = await imageProcessor.encode(nativePng, {
                format,
                ...(format === "jpeg" ? { quality: Math.round(quality * 100) } : {}),
                resize: { maxSide: maxWidth, enlarge: false },
              });
              encoded = result.data;
              width = result.width;
              height = result.height;
            }
            adoptGeneration(frameState, executionDriver.generation);
            const displayFrameId = issueFrame(frameState, geometry, {
              width,
              height,
              referenceWidth: maxWidth,
            });
            return JSON.stringify({
              format,
              base64: encoded.toString("base64"),
              displayFrameId,
              screenIndex: 0,
              width,
              height,
            });
          }),
        act: async (paramsJSON, signal) =>
          await queue.run(async () => {
            assertOpen();
            if (!isSupportedPlatform) {
              throw new Error(
                platform === "darwin"
                  ? `COMPUTER_DRIVER_UNAVAILABLE: cua-computer requires app-provided ${CUA_DRIVER_ENDPOINT_ENV}`
                  : "COMPUTER_DRIVER_UNAVAILABLE: cua-computer supports macOS, Windows, and Linux",
              );
            }
            return await handleWindowAct(
              platform,
              executionDriver,
              frameState,
              executionState,
              parseComputerActParamsJSON(paramsJSON),
              handleDesktopAct,
              signal,
            );
          }),
        close: async (reason) => {
          if (closePromise) {
            return await closePromise;
          }
          closing = true;
          closePromise = queue.run(async () => {
            let failure: unknown;
            try {
              await closeRecordingExecution({
                driver: executionDriver,
                state: executionState.recording,
                resources,
                reason,
              });
            } catch (error) {
              failure = error;
            }
            await resources.dispose(reason !== "completion").catch((error: unknown) => {
              failure ??= error;
            });
            await executionDriver.dispose().catch((error: unknown) => {
              failure ??= error;
            });
            if (failure) {
              throw failure instanceof Error
                ? failure
                : new Error("CUA Computer cleanup failed", { cause: failure });
            }
          });
          return await closePromise;
        },
      };
    },
  };
}
