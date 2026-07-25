// Discord tests cover realtime voice activation policy.
import { describe, expect, it } from "vitest";
import {
  isDiscordRealtimeWakeNameRequired,
  resolveDiscordRealtimeWakeNamePolicy,
} from "./activation.js";

describe("Discord realtime voice activation", () => {
  it("defaults to adaptive wake names for OpenAI agent-proxy voice", () => {
    const policy = resolveDiscordRealtimeWakeNamePolicy({
      isAgentProxy: true,
      providerId: "openai",
      requireWakeName: undefined,
    });

    expect(policy).toBe("automatic");
    expect(isDiscordRealtimeWakeNameRequired(policy, 0)).toBe(false);
    expect(isDiscordRealtimeWakeNameRequired(policy, 1)).toBe(false);
    expect(isDiscordRealtimeWakeNameRequired(policy, 2)).toBe(true);
  });

  it("preserves explicit wake-name overrides", () => {
    expect(
      resolveDiscordRealtimeWakeNamePolicy({
        isAgentProxy: true,
        providerId: "openai",
        requireWakeName: true,
      }),
    ).toBe("always");
    expect(
      resolveDiscordRealtimeWakeNamePolicy({
        isAgentProxy: true,
        providerId: "openai",
        requireWakeName: false,
      }),
    ).toBe("never");
  });

  it("does not apply wake-name gating outside supported agent-proxy voice", () => {
    expect(
      resolveDiscordRealtimeWakeNamePolicy({
        isAgentProxy: false,
        providerId: "openai",
        requireWakeName: true,
      }),
    ).toBe("never");
    expect(
      resolveDiscordRealtimeWakeNamePolicy({
        isAgentProxy: true,
        providerId: "google",
        requireWakeName: true,
      }),
    ).toBe("never");
  });
});
