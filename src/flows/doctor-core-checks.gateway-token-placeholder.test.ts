// Covers doctor detection of a gateway.auth.token that is a stringified nullish placeholder.
import { describe, expect, it } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const gatewayAuthCheck = () =>
  CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

async function detectFindings(token: string) {
  return await gatewayAuthCheck()?.detect({
    mode: "lint",
    runtime: { log() {}, error() {}, exit() {} },
    cfg: {
      gateway: {
        mode: "local",
        auth: { mode: "token", token },
      },
    },
    cwd: process.cwd(),
  });
}

describe("doctor gateway auth placeholder token", () => {
  it.each(["undefined", "null", "  undefined  "])(
    'reports the literal token "%s" as an error',
    async (token) => {
      expect(await detectFindings(token)).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/gateway-auth",
          severity: "error",
          path: "gateway.auth.token",
          message: expect.stringContaining("gateway.auth.token is the literal string"),
          fixHint: expect.stringContaining("--generate-gateway-token"),
        }),
      ]);
    },
  );

  it("accepts a real token that merely contains the word undefined", async () => {
    expect(await detectFindings("undefined-but-actually-a-long-real-token")).toEqual([]);
  });
});
