import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isRealtimeVoiceWakeNameRequired,
  resolveRealtimeVoiceBargeIn,
  resolveRealtimeVoiceInterruptResponseOnInputAudio,
  resolveRealtimeVoiceMinBargeInAudioEndMs,
  resolveRealtimeVoiceSessionPolicy,
} from "./realtime-session-policy.js";

const cfg = {
  agents: { list: [{ id: "agent-1", identity: { name: "Molty" } }] },
} as OpenClawConfig;

describe("realtime voice session policy", () => {
  it("defaults agent-proxy sessions to owner consults and adaptive wake names", () => {
    expect(
      resolveRealtimeVoiceSessionPolicy({
        isAgentProxy: true,
        supportsActivationNameGating: true,
        configuredToolPolicy: undefined,
        configuredConsultPolicy: undefined,
        requireWakeName: undefined,
        configuredWakeNames: undefined,
        cfg,
        agentId: "agent-1",
      }),
    ).toStrictEqual({
      toolPolicy: "owner",
      consultToolsAllow: undefined,
      consultPolicy: "always",
      wakeNamePolicy: "automatic",
      wakeNames: ["openclaw", "molty"],
      autoRespondToAudio: false,
    });
  });

  it("preserves explicit wake-name overrides for capable agent-proxy sessions", () => {
    const resolve = (requireWakeName: boolean) =>
      resolveRealtimeVoiceSessionPolicy({
        isAgentProxy: true,
        supportsActivationNameGating: true,
        configuredToolPolicy: undefined,
        configuredConsultPolicy: undefined,
        requireWakeName,
        configuredWakeNames: undefined,
        cfg,
        agentId: "agent-1",
      });

    expect(resolve(true).wakeNamePolicy).toBe("always");
    expect(resolve(false)).toMatchObject({ wakeNamePolicy: "never", wakeNames: [] });
  });

  it("disables wake-name gating outside capable agent-proxy sessions", () => {
    const base = {
      configuredToolPolicy: undefined,
      configuredConsultPolicy: "auto" as const,
      requireWakeName: true,
      configuredWakeNames: undefined,
      cfg,
      agentId: "agent-1",
    };

    expect(
      resolveRealtimeVoiceSessionPolicy({
        ...base,
        isAgentProxy: false,
        supportsActivationNameGating: true,
      }),
    ).toMatchObject({
      toolPolicy: "safe-read-only",
      consultPolicy: "auto",
      wakeNamePolicy: "never",
      wakeNames: [],
      autoRespondToAudio: true,
    });
    expect(
      resolveRealtimeVoiceSessionPolicy({
        ...base,
        isAgentProxy: true,
        supportsActivationNameGating: false,
      }),
    ).toMatchObject({
      wakeNamePolicy: "never",
      wakeNames: [],
      autoRespondToAudio: true,
    });
  });

  it("normalizes configured wake names instead of adding defaults", () => {
    const policy = resolveRealtimeVoiceSessionPolicy({
      isAgentProxy: true,
      supportsActivationNameGating: true,
      configuredToolPolicy: "safe-read-only",
      configuredConsultPolicy: "auto",
      requireWakeName: true,
      configuredWakeNames: [" Claw ", "Claw Bot Helper", "claw"],
      cfg,
      agentId: "agent-1",
    });

    expect(policy.toolPolicy).toBe("safe-read-only");
    expect(policy.consultToolsAllow).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(policy.wakeNames).toStrictEqual(["claw"]);
  });

  it("requires automatic wake names only for shared human participation", () => {
    expect(isRealtimeVoiceWakeNameRequired("always", 0)).toBe(true);
    expect(isRealtimeVoiceWakeNameRequired("automatic", 1)).toBe(false);
    expect(isRealtimeVoiceWakeNameRequired("automatic", 2)).toBe(true);
    expect(isRealtimeVoiceWakeNameRequired("never", 3)).toBe(false);
  });

  it("resolves provider-driven barge-in defaults", () => {
    expect(resolveRealtimeVoiceInterruptResponseOnInputAudio(undefined)).toBe(true);
    expect(resolveRealtimeVoiceInterruptResponseOnInputAudio(false)).toBe(false);
    expect(resolveRealtimeVoiceInterruptResponseOnInputAudio("false")).toBe(true);
    expect(
      resolveRealtimeVoiceBargeIn({
        configuredBargeIn: false,
        interruptResponseOnInputAudio: true,
      }),
    ).toBe(false);
    expect(
      resolveRealtimeVoiceBargeIn({
        configuredBargeIn: undefined,
        interruptResponseOnInputAudio: false,
      }),
    ).toBe(false);
    expect(resolveRealtimeVoiceMinBargeInAudioEndMs(undefined)).toBe(250);
    expect(resolveRealtimeVoiceMinBargeInAudioEndMs(0)).toBe(0);
  });
});
