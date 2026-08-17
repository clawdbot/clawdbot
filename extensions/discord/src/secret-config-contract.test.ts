import { describe, expect, it } from "vitest";
import { secretTargetRegistryEntries } from "./secret-config-contract.js";

describe("Discord secret target registry", () => {
  it.each([
    [
      "channels.discord.voice.realtime.providers.*.apiKey",
      "channels.discord.voice.realtime.providers.openai.apiKey",
    ],
    [
      "channels.discord.voice.tts.providers.*.apiKey",
      "channels.discord.voice.tts.providers.openai.apiKey",
    ],
    [
      "channels.discord.accounts.*.voice.realtime.providers.*.apiKey",
      "channels.discord.accounts.work.voice.realtime.providers.openai.apiKey",
    ],
    [
      "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
      "channels.discord.accounts.work.voice.tts.providers.openai.apiKey",
    ],
  ])("identifies the provider segment for %s", (targetId, concretePath) => {
    const entry = secretTargetRegistryEntries.find((candidate) => candidate.id === targetId);

    expect(entry).toBeDefined();
    expect(concretePath.split(".")[entry?.providerIdPathSegmentIndex ?? -1]).toBe("openai");
  });
});
