import { describe, expect, it, vi } from "vitest";
import {
  CLI_OUTBOUND_SEND_FACTORY,
  createOutboundSendDepsFromCliSource,
} from "./outbound-send-mapping.js";

describe("createOutboundSendDepsFromCliSource", () => {
  it("adds generic legacy aliases for channel-keyed send deps", () => {
    const deps = {
      whatsapp: vi.fn(),
      telegram: vi.fn(),
      discord: vi.fn(),
      slack: vi.fn(),
      signal: vi.fn(),
      imessage: vi.fn(),
    };

    const outbound = createOutboundSendDepsFromCliSource(deps);

    expect(outbound).toEqual({
      whatsapp: deps.whatsapp,
      telegram: deps.telegram,
      discord: deps.discord,
      slack: deps.slack,
      signal: deps.signal,
      imessage: deps.imessage,
      sendWhatsapp: deps.whatsapp,
      sendTelegram: deps.telegram,
      sendDiscord: deps.discord,
      sendSlack: deps.slack,
      sendSignal: deps.signal,
      sendImessage: deps.imessage,
    });
  });

  it("does not manufacture Discord voice helper deps from the lazy channel factory", () => {
    const sendFactory = vi.fn((channelId: string) => vi.fn().mockName(channelId));
    const outbound = createOutboundSendDepsFromCliSource({
      [CLI_OUTBOUND_SEND_FACTORY]: sendFactory,
    });

    expect(outbound.discordVoice).toBeUndefined();
    expect(outbound.sendDiscordVoice).toBeUndefined();
    expect(sendFactory).not.toHaveBeenCalled();
  });

  it("preserves explicitly provided Discord voice helper deps", () => {
    const discordVoice = vi.fn();
    const outbound = createOutboundSendDepsFromCliSource({ discordVoice });

    expect(outbound.discordVoice).toBe(discordVoice);
    expect(outbound.sendDiscordVoice).toBe(discordVoice);
  });
});
