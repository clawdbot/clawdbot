// Browser tests cover cdp.screenshot params plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withCdpSocket } from "./cdp.helpers.js";
import { captureScreenshot } from "./cdp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { shouldUsePlaywrightForScreenshot } from "./profile-capabilities.js";

const sentMessages = vi.hoisted(() => {
  const msgs: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return msgs;
});

const mockState = vi.hoisted(() => ({
  bringToFrontError: undefined as Error | undefined,
}));

vi.mock("./cdp.helpers.js", () => ({
  withCdpSocket: vi.fn(
    async (
      _wsUrl: string,
      fn: (send: unknown) => Promise<unknown>,
      _opts?: { commandTimeoutMs?: number },
    ) => {
      const send = (method: string, params?: Record<string, unknown>) => {
        sentMessages.push({ method, params });
        if (method === "Page.bringToFront" && mockState.bringToFrontError) {
          return Promise.reject(mockState.bringToFrontError);
        }
        if (method === "Page.captureScreenshot") {
          return Promise.resolve({ data: "AAAA" });
        }
        return Promise.resolve({});
      };
      return fn(send);
    },
  ),
  appendCdpPath: vi.fn(),
  fetchJson: vi.fn(),
  isLoopbackHost: vi.fn(),
  isWebSocketUrl: vi.fn(),
}));

vi.mock("./navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
}));

const localProfile: ResolvedBrowserProfile = {
  name: "openclaw",
  cdpUrl: "http://127.0.0.1:18800",
  cdpPort: 18800,
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  color: "#FF4500",
  driver: "openclaw",
  headless: false,
  attachOnly: false,
};

beforeEach(() => {
  sentMessages.length = 0;
  mockState.bringToFrontError = undefined;
});

function requireSentMessage(method: string) {
  const message = sentMessages.find((m) => m.method === method);
  if (!message) {
    throw new Error(`expected ${method} CDP message`);
  }
  return message;
}

describe("CDP screenshot params", () => {
  it("viewport screenshot omits fromSurface and captureBeyondViewport", async () => {
    await captureScreenshot({ wsUrl: "ws://localhost:9222/devtools/page/X", format: "png" });

    const call = requireSentMessage("Page.captureScreenshot");
    expect(call.params?.format).toBe("png");
    expect(call.params).not.toHaveProperty("fromSurface");
    expect(call.params).not.toHaveProperty("captureBeyondViewport");
    expect(call.params).not.toHaveProperty("clip");

    const methods = sentMessages.map((message) => message.method);
    expect(methods).toContain("Page.bringToFront");
    expect(methods.indexOf("Page.enable")).toBeLessThan(methods.indexOf("Page.bringToFront"));
    expect(methods.indexOf("Page.bringToFront")).toBeLessThan(
      methods.indexOf("Page.captureScreenshot"),
    );

    const emulationCalls = sentMessages.filter(
      (m) => m.method === "Emulation.setDeviceMetricsOverride",
    );
    expect(emulationCalls).toHaveLength(0);
  });

  it("captures when Page.bringToFront is unsupported", async () => {
    mockState.bringToFrontError = new Error("unsupported");

    await captureScreenshot({ wsUrl: "ws://localhost:9222/devtools/page/X" });

    requireSentMessage("Page.captureScreenshot");
  });

  it.each([
    { name: "headed managed browser", headless: false, activates: false },
    { name: "headless managed browser", headless: true, activates: true },
  ])("activates only when needed for a $name", async ({ headless, activates }) => {
    await captureScreenshot({
      wsUrl: "ws://localhost:9222/devtools/page/X",
      format: "png",
      headless,
    });

    const methods = sentMessages.map((message) => message.method);
    expect(methods.includes("Page.bringToFront")).toBe(activates);
    expect(methods).toContain("Page.captureScreenshot");
  });

  it("uses the requested timeout as the raw CDP command timeout", async () => {
    await captureScreenshot({
      wsUrl: "ws://localhost:9222/devtools/page/X",
      format: "png",
      timeoutMs: 12_345,
    });

    const [wsUrl, sendCallback, options] =
      (withCdpSocket as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls.at(-1) ??
      [];
    expect(wsUrl).toBe("ws://localhost:9222/devtools/page/X");
    expect(typeof sendCallback).toBe("function");
    expect(options).toEqual({ commandTimeoutMs: 12_345 });
  });

  it("captures the full document without writing or guessing emulation state", async () => {
    await captureScreenshot({
      wsUrl: "ws://localhost:9222/devtools/page/X",
      format: "png",
      fullPage: true,
    });

    const captureCall = requireSentMessage("Page.captureScreenshot");
    expect(captureCall.params?.captureBeyondViewport).toBe(true);
    expect(sentMessages.some(({ method }) => method.startsWith("Emulation."))).toBe(false);
  });
});

describe("shouldUsePlaywrightForScreenshot routing", () => {
  it("returns false for a normal viewport screenshot with wsUrl", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x" })).toBe(
      false,
    );
  });

  it("returns true when wsUrl is missing", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile })).toBe(true);
  });

  it("returns true when ref is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x", ref: "btn-1" }),
    ).toBe(true);
  });

  it("returns true when element is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({
        profile: localProfile,
        wsUrl: "ws://x",
        element: "#submit",
      }),
    ).toBe(true);
  });
});
