import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TalkCatalogResultSchema } from "./channels.js";

function catalogWithActiveVoicePolicy(activeVoiceSelectionPolicy: unknown) {
  return {
    modes: ["realtime"],
    transports: ["gateway-relay"],
    brains: ["agent-consult"],
    speech: { providers: [] },
    transcription: { providers: [] },
    realtime: {
      providers: [
        {
          id: "realtime",
          label: "Realtime",
          configured: true,
          voices: ["provider-voice"],
          activeVoices: ["active-voice"],
          activeVoiceSelectionPolicy,
        },
      ],
    },
  };
}

describe("TalkCatalogResultSchema", () => {
  it("accepts only the authoritative voice allowlist policy", () => {
    expect(
      Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("allowlist-default")),
    ).toBe(true);
    expect(Value.Check(TalkCatalogResultSchema, catalogWithActiveVoicePolicy("free-form"))).toBe(
      false,
    );
  });
});
