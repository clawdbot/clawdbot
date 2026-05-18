import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";

describe("createPluginRuntimeMock", () => {
  it("keeps the inbound debouncer mock aligned with the runtime contract", () => {
    const runtime = createPluginRuntimeMock();
    const debouncer = runtime.channel.debounce.createInboundDebouncer({
      debounceMs: 0,
      buildKey: () => "key",
      onFlush: vi.fn(),
    });

    expect(debouncer.cancelKey("key")).toBe(false);
    expect(vi.isMockFunction(debouncer.cancelKey)).toBe(true);
  });
});
