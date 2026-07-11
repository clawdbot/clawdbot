import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateCrestodianSetupVerifyParams } from "../index.js";
import { CrestodianSetupVerifyResultSchema } from "./crestodian.js";

describe("Crestodian setup verification protocol", () => {
  it("accepts only an empty request", () => {
    expect(validateCrestodianSetupVerifyParams({})).toBe(true);
    expect(validateCrestodianSetupVerifyParams({ modelRef: "openai/gpt-5.5" })).toBe(false);
  });

  it("accepts the structured success and failure results", () => {
    expect(
      Value.Check(CrestodianSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
      }),
    ).toBe(true);
    expect(
      Value.Check(CrestodianSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
        error: "no configured model",
      }),
    ).toBe(true);
  });

  it("rejects mixed or incomplete results", () => {
    expect(
      Value.Check(CrestodianSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
        error: "stale failure",
      }),
    ).toBe(false);
    expect(
      Value.Check(CrestodianSetupVerifyResultSchema, {
        ok: false,
        status: "ok",
        error: "contradictory result",
      }),
    ).toBe(false);
    expect(
      Value.Check(CrestodianSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
      }),
    ).toBe(false);
  });
});
