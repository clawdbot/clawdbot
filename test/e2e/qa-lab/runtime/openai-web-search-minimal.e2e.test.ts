// OpenAI web-search minimal tests cover QA Lab hosted provider schema evidence.
import { describe, expect, it } from "vitest";
import { testing } from "../../../../scripts/e2e/lib/openai-web-search-minimal/client.mjs";

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

  it("rejects out-of-range gateway ports before connecting", () => {
    expect(() => testing.resolveGatewayPort({ PORT: "65536" })).toThrow("invalid PORT: 65536");
  });

  it("accepts success mode only when the final assistant reply contains the marker", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: {
          meta: { finalAssistantVisibleText: `done: ${testing.SUCCESS_MARKER}` },
          status: "ok",
        },
      }),
    ).not.toThrow();
  });

  it("accepts success markers from non-error reply payload text", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: {
          payloads: [{ text: testing.SUCCESS_MARKER }],
          status: "ok",
        },
      }),
    ).not.toThrow();
  });

  it("accepts success markers from the gateway agent result envelope", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: {
          result: {
            meta: { finalAssistantVisibleText: testing.SUCCESS_MARKER },
            payloads: [{ text: "secondary reply" }],
          },
          status: "ok",
        },
      }),
    ).not.toThrow();
  });

  it("fails success mode when the agent run completes without the marker", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: { status: "ok" },
      }),
    ).toThrow(/completed without success marker/u);
  });

  it("does not accept success markers from error payload text", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: {
          payloads: [{ isError: true, text: testing.SUCCESS_MARKER }],
          status: "ok",
        },
      }),
    ).toThrow(/completed without success marker/u);
  });

  it("keeps non-ok success mode failures distinct from marker failures", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: {
          meta: { finalAssistantVisibleText: testing.SUCCESS_MARKER },
          status: "blocked",
        },
      }),
    ).toThrow(/agent run did not complete successfully/u);
  });
});
