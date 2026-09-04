import { vi } from "vitest";
import type { RealtimeVoiceBridge } from "../talk/provider-types.js";

export const sessionTarget = {
  agentId: "main",
  sessionKey: "agent:main:main",
  canonicalKey: "agent:main:main",
  storePath: "/tmp/sessions",
};

export function controlContext(
  warn = vi.fn(),
  onTalkEvent?: (event: { type: string; payload: unknown }) => void,
) {
  return {
    logGateway: { warn },
    chatAbortControllers: new Map(),
    broadcastToConnIds: vi.fn((_name: string, payload: { talkEvent?: unknown }) => {
      if (payload.talkEvent) {
        onTalkEvent?.(payload.talkEvent as { type: string; payload: unknown });
      }
    }),
  } as never;
}

export function controlBridge() {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    sendUserMessage: vi.fn(),
    submitToolResult: vi.fn(async () => undefined),
    acknowledgeMark: vi.fn(),
    isConnected: vi.fn(() => true),
  } satisfies RealtimeVoiceBridge;
}
