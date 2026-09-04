import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withGatewayClient } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway usage request validation", () => {
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

  it("rejects invalid UTC offsets over RPC and preserves date interpretation precedence", async () => {
    await withGatewayClient(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      for (const method of ["usage.cost", "sessions.usage"]) {
        for (const utcOffset of ["UTC+14:01", "UTC-12:01", "UTC+99"]) {
          expect(await rpcReq(ws, method, { mode: "specific", utcOffset })).toMatchObject({
            ok: false,
            error: {
              code: ErrorCodes.INVALID_REQUEST,
              message: "invalid utcOffset: expected UTC-12:00 through UTC+14:00",
            },
          });
        }
        for (const params of [
          { mode: "specific", utcOffset: "UTC+14:00" },
          { mode: "specific", utcOffset: "UTC-12:00" },
          { mode: "specific", utcOffset: "UTC+5:30" },
          { mode: "specific" },
          { mode: "utc", utcOffset: "UTC+99" },
          { mode: "gateway", utcOffset: "UTC+99" },
          { mode: "specific", timeZone: "Europe/Vienna", utcOffset: "UTC+99" },
          { mode: "specific", timeZone: "Newer/BrowserZone", utcOffset: "UTC+1" },
        ]) {
          const response = await rpcReq(ws, method, {
            startDate: "2026-10-25",
            endDate: "2026-10-25",
            ...params,
          });
          expect(response.ok).toBe(true);
          expect(response.payload?.totals).toEqual(expect.any(Object));
        }
      }
    });
  });
});
