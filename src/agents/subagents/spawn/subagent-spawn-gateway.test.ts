import { describe, expect, it } from "vitest";
import { requireMatchingGatewayRunId } from "./subagent-spawn-gateway.js";

describe("subagent Gateway execution identity", () => {
  it("accepts the Gateway-owned idempotency key as the run ID", () => {
    expect(requireMatchingGatewayRunId({ runId: "launch-key" }, "launch-key")).toBe("launch-key");
  });

  it.each([{ runId: "different-run" }, {}, null])(
    "rejects a response that does not preserve the dispatch identity",
    (response) => {
      expect(() => requireMatchingGatewayRunId(response, "launch-key")).toThrow(
        "unexpected execution identity",
      );
    },
  );
});
