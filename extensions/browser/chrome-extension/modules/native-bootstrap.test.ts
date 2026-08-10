import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeBootstrapController } from "./native-bootstrap.js";

describe("native bootstrap timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds a stuck native call and leaves status retryable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "00112233-4455-6677-8899-aabbccddeeff"),
    });
    const stored: Record<string, unknown> = {};
    let onDisconnect = () => {};
    const disconnect = vi.fn(() => onDisconnect());
    const chromeApi = {
      runtime: {
        connectNative: vi.fn(() => ({
          disconnect,
          onDisconnect: {
            addListener: (listener: () => void) => {
              onDisconnect = listener;
            },
          },
          onMessage: { addListener: vi.fn() },
          postMessage: vi.fn(),
        })),
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(
              keys.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]),
            ),
          ),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(stored, values);
          }),
          remove: vi.fn(async (keys: string[]) => {
            for (const key of keys) {
              delete stored[key];
            }
          }),
        },
      },
    };
    const controller = createNativeBootstrapController({
      chromeApi,
      getPairing: async () => null,
      applyPairing: vi.fn(),
    });

    const attempt = controller.attempt();
    await vi.advanceTimersByTimeAsync(0);
    expect(chromeApi.runtime.connectNative.mock.results[0]?.value.postMessage).toHaveBeenCalledWith(
      {
        v: 1,
        op: "bootstrap",
        nonce: "ABEiM0RVZneImaq7zN3u_w",
      },
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stored).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    await expect(attempt).resolves.toEqual({
      status: "retrying",
      code: "native_host_timeout",
    });
    await expect(controller.status()).resolves.toEqual({
      disabled: false,
      state: "retrying",
      failureCode: "native_host_timeout",
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
