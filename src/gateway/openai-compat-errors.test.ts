/**
 * Tests OpenAI-compatible error envelope mapping.
 */
import { describe, expect, it } from "vitest";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import { resolveOpenAiCompatError } from "./openai-compat-errors.js";

describe("resolveOpenAiCompatError", () => {
  it("maps GatewayDrainingError to a 503 service_unavailable envelope", () => {
    expect(resolveOpenAiCompatError(new GatewayDrainingError())).toEqual({
      status: 503,
      error: {
        message: "Gateway is draining; new tasks are not accepted",
        type: "service_unavailable",
        code: "gateway_unavailable",
      },
    });
  });

  it("matches by error name so duplicated bundled classes still map", () => {
    const err = new Error("Gateway is draining; new tasks are not accepted");
    err.name = "GatewayDrainingError";
    expect(resolveOpenAiCompatError(err)?.status).toBe(503);
  });

  it("returns undefined for errors without a failover reason", () => {
    expect(resolveOpenAiCompatError(new Error("boom"))).toBeUndefined();
  });
});
