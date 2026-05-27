import { describe, expect, it } from "vitest";
import {
  isSupportedRealtimeVoiceActivationName,
  matchRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
  normalizeSupportedRealtimeVoiceActivationName,
  sortRealtimeVoiceActivationNames,
} from "./activation-name.js";

describe("realtime voice activation names", () => {
  it("normalizes and validates one- or two-word activation names", () => {
    expect(normalizeSupportedRealtimeVoiceActivationName("  OpenClaw  ")).toBe("openclaw");
    expect(normalizeSupportedRealtimeVoiceActivationName("Open Claw")).toBe("open claw");
    expect(normalizeSupportedRealtimeVoiceActivationName("Claw Bot Helper")).toBeUndefined();
    expect(isSupportedRealtimeVoiceActivationName("Claw Bot")).toBe(true);
    expect(isSupportedRealtimeVoiceActivationName("Claw Bot Helper")).toBe(false);
    expect(normalizeRealtimeVoiceActivationNamePrefix("Claw Bot Helper")).toBe("Claw Bot");
  });

  it("matches and strips leading exact activation names", () => {
    expect(matchRealtimeVoiceActivationName("Hey, Molty, ship it", ["molty"])).toEqual({
      allowed: true,
      activationName: "molty",
      edge: "leading",
      heardName: "molty",
      match: "exact",
      text: "ship it",
    });
  });

  it("matches and strips trailing exact activation names", () => {
    expect(matchRealtimeVoiceActivationName("ship it, Claw Bot", ["claw bot"])).toEqual({
      allowed: true,
      activationName: "claw bot",
      edge: "trailing",
      heardName: "claw bot",
      match: "exact",
      text: "ship it",
    });
  });

  it("accepts bounded fuzzy matches at the transcript edge", () => {
    expect(matchRealtimeVoiceActivationName("Malty, what changed?", ["molty"])).toMatchObject({
      allowed: true,
      activationName: "molty",
      edge: "leading",
      heardName: "malty",
      match: "fuzzy",
      text: "what changed?",
    });
    expect(matchRealtimeVoiceActivationName("what changed, Malty?", ["molty"])).toMatchObject({
      allowed: true,
      activationName: "molty",
      edge: "trailing",
      heardName: "malty",
      match: "fuzzy",
      text: "what changed",
    });
    expect(matchRealtimeVoiceActivationName("what changed, Marty?", ["molty"])).toMatchObject({
      allowed: true,
      activationName: "molty",
      edge: "trailing",
      heardName: "marty",
      match: "fuzzy",
      text: "what changed",
    });
  });

  it("does not accept fuzzy trailing matches in ambient speech", () => {
    expect(
      matchRealtimeVoiceActivationName("I miss the nonsensical German ranting from Multy.", [
        "molty",
      ]),
    ).toBeUndefined();
    expect(matchRealtimeVoiceActivationName("I agree, mostly.", ["molty"])).toBeUndefined();
    expect(matchRealtimeVoiceActivationName("the room is damp, moldy.", ["molty"])).toBeUndefined();
    expect(matchRealtimeVoiceActivationName("the room is damp, moldy?", ["molty"])).toBeUndefined();
    expect(matchRealtimeVoiceActivationName("what changed, Malty.", ["molty"])).toBeUndefined();
  });

  it("does not fuzzy match inside a larger phrase without an edge boundary", () => {
    expect(matchRealtimeVoiceActivationName("maltiness is not a wake name", ["molty"])).toBe(
      undefined,
    );
  });

  it("prefers longer activation names first", () => {
    expect(sortRealtimeVoiceActivationNames(["claw", "claw bot", "openclaw"])).toEqual([
      "claw bot",
      "openclaw",
      "claw",
    ]);
    expect(matchRealtimeVoiceActivationName("Claw Bot, status", ["claw", "claw bot"])).toEqual({
      allowed: true,
      activationName: "claw bot",
      edge: "leading",
      heardName: "claw bot",
      match: "exact",
      text: "status",
    });
  });
});
