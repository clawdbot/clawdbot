import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withGatewayClient } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway usage.cost agent scope", () => {
  it("rejects conflicting scope selectors and preserves valid selectors", async () => {
    await withGatewayClient(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });

      const conflict = await rpcReq(ws, "usage.cost", {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        agentId: "main",
        agentScope: "all",
      });
      expect(conflict).toMatchObject({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: "agentScope=all cannot be combined with agentId",
        },
      });

      for (const params of [
        { agentId: "main" },
        { agentScope: "all" },
        { agentId: "  ", agentScope: "all" },
      ]) {
        const response = await rpcReq<{ totals?: { totalTokens?: number } }>(ws, "usage.cost", {
          startDate: "2026-02-01",
          endDate: "2026-02-02",
          ...params,
        });
        expect(response.ok).toBe(true);
        expect(response.payload?.totals).toEqual(expect.any(Object));
      }
    });
  });
});
