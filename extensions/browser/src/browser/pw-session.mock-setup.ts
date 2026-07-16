import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export const connectOverCdpMock: MockFn = vi.fn();
export const getChromeWebSocketUrlMock: MockFn = vi.fn();

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: (...args: unknown[]) => connectOverCdpMock(...args),
  },
}));

vi.mock("./chrome.js", () => ({
  getChromeWebSocketUrl: (...args: unknown[]) => getChromeWebSocketUrlMock(...args),
}));
