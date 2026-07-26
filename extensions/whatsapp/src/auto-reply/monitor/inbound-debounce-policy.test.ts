import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { resolveWhatsAppInboundDebounceDecision } from "./inbound-debounce-policy.js";

const { runInboundDebounceMock } = vi.hoisted(() => ({
  runInboundDebounceMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: () => true,
    runInboundDebounce: runInboundDebounceMock,
  }),
}));

describe("resolveWhatsAppInboundDebounceDecision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runInboundDebounceMock.mockReset();
  });

  it("falls back to the channel decision when the hook rejects", async () => {
    runInboundDebounceMock.mockRejectedValue(new Error("plugin failed"));
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

    await expect(
      resolveWhatsAppInboundDebounceDecision({
        cfg: {},
        msg: createTestWebInboundMessage(),
        defaultDebounceMs: 25,
        shouldDebounce: () => true,
      }),
    ).resolves.toEqual({ action: "debounce", debounceMs: 25 });
    expect(errorSpy).toHaveBeenCalledWith(
      "whatsapp: inbound debounce hook failed; using the channel default decision",
    );
  });
});
