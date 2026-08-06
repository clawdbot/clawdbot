import type { PluginRuntime } from "openclaw/plugin-sdk/core";
// Whatsapp tests cover runtime injection across plugin registry reloads.
import { describe, expect, it } from "vitest";
import {
  getOptionalWhatsAppChannelRuntime,
  getWhatsAppChannelRuntime,
  getWhatsAppRuntime,
  setWhatsAppRuntime,
} from "./runtime.js";

describe("WhatsApp runtime", () => {
  it("preserves the channel context owner when the injected runtime changes", () => {
    const originalChannelRuntime = getOptionalWhatsAppChannelRuntime();
    const first = { channel: { runtimeContexts: { id: "first" } } } as unknown as PluginRuntime;
    const second = { channel: { runtimeContexts: { id: "second" } } } as unknown as PluginRuntime;

    setWhatsAppRuntime(first);
    setWhatsAppRuntime(second);

    expect(getWhatsAppRuntime()).toBe(second);
    expect(getWhatsAppChannelRuntime()).toBe(originalChannelRuntime ?? first.channel);
  });
});
