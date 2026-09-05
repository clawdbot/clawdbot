import { describe, expect, it } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { FailoverError } from "../agents/failover-error.js";
import { unwrapGatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";

describe("in-process gateway error causes", () => {
  it("preserves typed failover metadata across the response envelope", () => {
    const original = new FailoverError("All models failed", {
      reason: "overloaded",
      attempts: [
        { provider: "openai", model: "gpt-5.6", reason: "overloaded", error: "overloaded" },
      ],
    });
    const error = errorShape(ErrorCodes.UNAVAILABLE, original.message, {
      details: { reason: "busy" },
      retryable: true,
      retryAfterMs: 250,
    });
    const payload = { runId: "in-process-run", privateResult: "not-for-logs" };
    Object.defineProperty(error, "cause", { value: original });

    let thrown: unknown;
    try {
      unwrapGatewayMethodDispatchResponse("agent", { ok: false, payload, error });
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(GatewayClientRequestError);
    expect((thrown as Error).cause).toBe(original);
    expect(thrown).toMatchObject({ ...error, gatewayCode: error.code, responsePayload: payload });
    expect(JSON.stringify(thrown)).not.toContain('"cause":');
    expect(JSON.stringify(thrown)).not.toContain("not-for-logs");
  });
});
