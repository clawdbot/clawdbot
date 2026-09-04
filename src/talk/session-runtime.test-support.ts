import { vi } from "vitest";
import type { RealtimeVoiceBridge } from "./provider-types.js";

export function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
  return {
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    triggerGreeting: vi.fn(),
    ...overrides,
  };
}
