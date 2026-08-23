/**
 * Playwright session mock setup.
 *
 * Provides shared vi mocks for tests that need to replace Playwright CDP
 * connection and Chrome WebSocket URL discovery.
 */
import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

/** Mock for playwright.chromium.connectOverCDP. */
export const connectOverCdpMock: MockFn = vi.fn();
/** Mock for Chrome CDP WebSocket URL discovery. */
export const getChromeWebSocketUrlMock: MockFn = vi.fn();

vi.mock("./playwright-core.runtime.js", () => ({
  playwrightCore: {
    chromium: {
      connectOverCDP: (...args: unknown[]) => connectOverCdpMock(...args),
    },
    devices: {},
  },
}));

vi.mock("./chrome.js", () => ({
  getChromeWebSocketUrl: (...args: unknown[]) => getChromeWebSocketUrlMock(...args),
}));
