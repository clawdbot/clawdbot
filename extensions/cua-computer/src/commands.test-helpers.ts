import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { createCuaComputerProvider } from "./commands.js";
import type { CuaDriverSession, CuaToolResult } from "./driver-client.js";

const geometry = {
  platform: "linux",
  display: "primary",
  screenshot_width: 100,
  screenshot_height: 50,
  screen_width: 100,
  screen_height: 50,
  scale_factor: 1,
};

const CUA_DRIVER_ENDPOINT_ENV = "OPENCLAW_CUA_DRIVER_ENDPOINT";

export function macOsEndpoint(overrides: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  return {
    [CUA_DRIVER_ENDPOINT_ENV]: JSON.stringify({
      v: 1,
      socketPath: "/tmp/openclaw-cua-test/driver.sock",
      binaryPath: process.execPath,
      ...overrides,
    }),
  };
}

export function invalidMacOsEndpoints(): Array<[string, NodeJS.ProcessEnv]> {
  return [
    ["missing", {}],
    ["malformed JSON", { [CUA_DRIVER_ENDPOINT_ENV]: "{" }],
    [
      "partial",
      {
        [CUA_DRIVER_ENDPOINT_ENV]: JSON.stringify({
          v: 1,
          socketPath: "/tmp/openclaw-cua-test/driver.sock",
        }),
      },
    ],
    ["unsupported version", macOsEndpoint({ v: 2 })],
    ["extra field", macOsEndpoint({ extra: true })],
    ["relative socket", macOsEndpoint({ socketPath: "relative.sock" })],
    ["relative binary", macOsEndpoint({ binaryPath: "cua-driver" })],
    ["nul socket", macOsEndpoint({ socketPath: "/tmp/cua\0.sock" })],
    ["missing binary", macOsEndpoint({ binaryPath: "/missing/cua-driver" })],
    ["oversized", macOsEndpoint({ socketPath: `/${"x".repeat(4_096)}` })],
  ];
}

export function result(structured: Record<string, unknown>, image = false): CuaToolResult {
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

export function driver(
  options: {
    geometry?: typeof geometry;
    screenSize?: { width: number; height: number; scale_factor: number };
  } = {},
) {
  let generation = "execution-1";
  const activeGeometry = options.geometry ?? geometry;
  const getDesktopState = vi.fn(async () => result(activeGeometry, true));
  const getScreenSize = vi.fn(async () =>
    result(
      options.screenSize ?? {
        width: activeGeometry.screen_width,
        height: activeGeometry.screen_height,
        scale_factor: activeGeometry.scale_factor,
      },
    ),
  );
  const click = vi.fn(async () => result({}));
  const drag = vi.fn(async () => result({}));
  const moveCursor = vi.fn(async () => result({}));
  const scroll = vi.fn(async () => result({}));
  const typeText = vi.fn(async () => result({}));
  const pressKey = vi.fn(async () => result({}));
  const callTool = vi.fn<CuaDriverSession["callTool"]>(async () => result({}));
  const getCursorPosition = vi.fn<CuaDriverSession["getCursorPosition"]>(async () => result({}));
  const escalateScope = vi.fn(async () => ({
    session: "openclaw-test",
    captureScope: 2,
    effectiveScope: 1,
    desktopUnlocked: true,
  }));
  const dispose = vi.fn(async () => {});
  const session: CuaDriverSession = {
    get generation() {
      return generation;
    },
    isAvailable: () => true,
    resetAvailabilityCache: () => {},
    callTool,
    getCursorPosition,
    escalateScope,
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
    callTool,
    getCursorPosition,
    escalateScope,
    dispose,
    typeText,
    pressKey,
    setGeneration: (value: string) => {
      generation = value;
    },
  };
}

export async function execution(session: CuaDriverSession) {
  return await createCuaComputerProvider({
    platform: "linux",
    driver: session,
    imageProcessor: {
      encode: vi.fn(async () => ({ data: Buffer.from("jpeg"), width: 100, height: 50 })),
    },
  }).openExecution({ executionId: randomUUID() });
}
