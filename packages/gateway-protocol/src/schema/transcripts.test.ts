import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateTranscriptsGetParams,
  validateTranscriptsListParams,
} from "../validator-registry.js";
import { TranscriptsListResultSchema } from "./transcripts.js";

describe("meeting transcript contracts", () => {
  it("validates additive read inputs and rejects unrelated keys", () => {
    expect(validateTranscriptsListParams({})).toBe(true);
    expect(validateTranscriptsListParams({ limit: 200, providerId: "voice" })).toBe(true);
    expect(
      validateTranscriptsGetParams({ selector: "date/meeting", includeUtterances: true }),
    ).toBe(true);
    expect(validateTranscriptsGetParams({ selector: "" })).toBe(false);
    expect(validateTranscriptsGetParams({ selector: "meeting", sessionId: "meeting" })).toBe(false);
  });
  it("closes the locator boundary and bounds overview previews", () => {
    const session = {
      selector: "date/meeting",
      sessionId: "meeting",
      providerId: "voice",
      source: { providerId: "voice" },
      startedAt: "2026-08-02T00:00:00Z",
      active: false,
      utteranceCount: 0,
      participants: [],
      hasSummary: false,
    };
    expect(Value.Check(TranscriptsListResultSchema, { sessions: [session] })).toBe(true);
    expect(
      Value.Check(TranscriptsListResultSchema, {
        sessions: [{ ...session, source: { ...session.source, private: "hidden" } }],
      }),
    ).toBe(false);
    expect(
      Value.Check(TranscriptsListResultSchema, {
        sessions: [{ ...session, overview: "x".repeat(281) }],
      }),
    ).toBe(false);
  });
});
