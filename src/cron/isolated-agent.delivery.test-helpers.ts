// Isolated agent delivery test helpers build delivery targets and mocks.
import { vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import type { CliDeps } from "../cli/deps.js";

/** Creates mocked CLI delivery deps for isolated-agent delivery tests. */
export function createCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    sendMessageSlack: vi.fn().mockResolvedValue({ messageTs: "slack-1", channel: "C1" }),
    sendMessageWhatsApp: vi
      .fn()
      .mockResolvedValue({ messageId: "wa-1", toJid: "123@s.whatsapp.net" }),
    sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "123" }),
    sendMessageDiscord: vi.fn().mockResolvedValue({ messageId: "discord-1", channelId: "123" }),
    sendMessageSignal: vi.fn().mockResolvedValue({ messageId: "signal-1", conversationId: "123" }),
    sendMessageIMessage: vi.fn().mockResolvedValue({ messageId: "imessage-1", chatId: "123" }),
    ...overrides,
  };
}

export function mockAgentPayloads(
  payloads: Array<Record<string, unknown>>,
  extra: Partial<Awaited<ReturnType<typeof runEmbeddedAgent>>> = {},
): void {
  vi.mocked(runEmbeddedAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
    ...extra,
  });
}
