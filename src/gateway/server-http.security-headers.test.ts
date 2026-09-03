import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

describe("gateway HTTP security headers", () => {
  it("updates security headers on the existing server from published config", async () => {
    await withGatewayServer({
      prefix: "http-hot-security-headers",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        for (const [value, expected] of [
          [undefined, undefined],
          ["  max-age=60; includeSubDomains  ", "max-age=60; includeSubDomains"],
          ["max-age=0", "max-age=0"],
          [false, undefined],
          ["   ", undefined],
          ["max-age=120", "max-age=120"],
          [undefined, undefined],
        ] as const) {
          setRuntimeConfigSnapshot({
            gateway: { http: { securityHeaders: { strictTransportSecurity: value } } },
          });
          for (const path of ["/healthz", "/unclaimed-route"]) {
            const response = createResponse();
            await dispatchRequest(server, createRequest({ path }), response.res);
            expect(response.res.statusCode).toBe(path === "/healthz" ? 200 : 404);
            const headers = Object.fromEntries(response.setHeader.mock.calls);
            expect(headers["Strict-Transport-Security"]).toBe(expected);
            expect(headers["X-Content-Type-Options"]).toBe("nosniff");
            expect(headers["Referrer-Policy"]).toBe("no-referrer");
          }
        }
      },
    });
  });
});
