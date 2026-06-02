import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/e2e/lib/openai-web-search-minimal/client.mjs";

describe("scripts/e2e/lib/openai-web-search-minimal/client.mjs", () => {
  it("accepts only the expected raw schema rejection in reject mode", () => {
    expect(
      testing.validateRejectResult({
        ok: false,
        error: new Error(`gateway failed: ${testing.DEFAULT_RAW_SCHEMA_ERROR}`),
      }),
    ).toContain(testing.DEFAULT_RAW_SCHEMA_ERROR);
  });

  it("accepts the gateway schema rejection wrapper in reject mode", () => {
    expect(
      testing.validateRejectResult({
        ok: false,
        error: new Error(
          `GatewayClientRequestError: FailoverError: ${testing.DEFAULT_GATEWAY_SCHEMA_ERROR}.`,
        ),
      }),
    ).toContain(testing.DEFAULT_GATEWAY_SCHEMA_ERROR);
  });

  it("fails reject mode when the agent run unexpectedly succeeds", () => {
    expect(() =>
      testing.validateRejectResult({
        ok: true,
        value: { status: "ok" },
      }),
    ).toThrow(/reject mode unexpectedly completed/u);
  });

  it("fails reject mode on unrelated transport errors", () => {
    expect(() =>
      testing.validateRejectResult({
        ok: false,
        error: new Error("connect ECONNREFUSED 127.0.0.1:9"),
      }),
    ).toThrow(/reject mode failed for an unexpected reason/u);
  });
});
