import { expect, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { CliDeps } from "../cli/deps.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob } from "./isolated-agent.test-harness.js";

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
  extra: Partial<Awaited<ReturnType<typeof runEmbeddedPiAgent>>> = {},
): void {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
    ...extra,
  });
}

export function expectDirectTelegramDelivery(
  deps: CliDeps,
  params: { chatId: string; text: string; messageThreadId?: number },
) {
  expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
  expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
    params.chatId,
    params.text,
    expect.objectContaining(
      params.messageThreadId === undefined ? {} : { messageThreadId: params.messageThreadId },
    ),
  );
}

export async function runTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  delivery: {
    mode: "announce";
    channel: string;
    to?: string;
    bestEffort?: boolean;
  };
}): Promise<Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>> {
  return runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath, {
      channels: { telegram: { botToken: "t-1" } },
    }),
    deps: params.deps,
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      delivery: params.delivery,
    },
    message: "do it",
    sessionKey: "cron:job-1",
    lane: "cron",
  });
}
