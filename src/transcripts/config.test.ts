import { describe, expect, it } from "vitest";
import { resolveTranscriptsConfig } from "./config.js";

describe("resolveTranscriptsConfig", () => {
  it("enables meeting transcripts by default with an explicit global opt-out", () => {
    expect(resolveTranscriptsConfig(undefined).enabled).toBe(true);
    expect(resolveTranscriptsConfig({}).enabled).toBe(true);
    expect(resolveTranscriptsConfig({ enabled: false }).enabled).toBe(false);
  });

  it.each([
    { whenOccupied: undefined, expected: false, sessionId: "daily" },
    { whenOccupied: false, expected: false, sessionId: "daily" },
    { whenOccupied: true, expected: true, sessionId: undefined },
  ])(
    "uses occupancy only when opted in ($whenOccupied)",
    ({ whenOccupied, expected, sessionId }) => {
      const { autoStart } = resolveTranscriptsConfig({
        autoStart: [{ providerId: "voice-test", sessionId: "daily", whenOccupied }],
      });
      expect(autoStart).toEqual([
        expect.objectContaining({ providerId: "voice-test", whenOccupied: expected, sessionId }),
      ]);
    },
  );
});
