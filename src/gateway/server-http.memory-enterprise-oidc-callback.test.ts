import { describe, expect, it } from "vitest";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

describe("Gateway enterprise OIDC callback route", () => {
  it("is public but state-bound, ahead of plugin routing, and never returns a Gateway auth challenge", async () => {
    await withGatewayServer({
      prefix: "memory-enterprise-oidc-callback-route",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest: async () => {
          throw new Error("the core OIDC callback must run before plugin routing");
        },
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: `/memory/oidc/callback?state=${"s".repeat(43)}&code=provider-code`,
            method: "GET",
          }),
          response.res,
        );

        expect(response.res.statusCode).toBe(400);
        expect(response.getBody()).toContain("Sign-in could not be completed");
        expect(response.getBody()).not.toContain("Unauthorized");
        expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, max-age=0");
      },
    });
  });
});
