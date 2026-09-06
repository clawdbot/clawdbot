// Covers doctor detection of a gateway.auth.token that is a stringified nullish placeholder.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const gatewayAuthCheck = () =>
  CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

async function detectFindings(
  token: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"],
  mode: "token" | "password" | "none" = "token",
  env: NodeJS.ProcessEnv = {},
) {
  return await gatewayAuthCheck()?.detect({
    mode: "lint",
    runtime: { log() {}, error() {}, exit() {} },
    cfg: {
      gateway: {
        mode: "local",
        auth: { mode, token, ...(mode === "password" ? { password: "synthetic-password" } : {}) },
      },
    },
    cwd: process.cwd(),
    env,
  });
}

describe("doctor gateway auth placeholder token", () => {
  it.each(["undefined", "null", "  undefined  ", "", "  "])(
    'reports the literal token "%s" as an error',
    async (token) => {
      expect(await detectFindings(token)).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/gateway-auth",
          severity: "error",
          path: "gateway.auth.token",
          message: expect.stringContaining("not a usable secret"),
          fixHint: expect.stringContaining("--generate-gateway-token"),
        }),
      ]);
    },
  );

  it.each(["password", "none"] as const)(
    "leaves %s auth authoritative over an inactive placeholder token",
    async (mode) => {
      expect(await detectFindings("undefined", mode)).toEqual([]);
    },
  );

  it("keeps a SecretRef authoritative over an ambient placeholder", async () => {
    expect(
      await detectFindings({ source: "env", provider: "default", id: "SYNTHETIC_TOKEN" }, "token", {
        SYNTHETIC_TOKEN: "synthetic-valid-token",
        OPENCLAW_GATEWAY_TOKEN: "undefined",
      }),
    ).toEqual([]);
  });

  it("reports a placeholder from a SecretRef without proposing plaintext rotation", async () => {
    expect(
      await detectFindings({ source: "env", provider: "default", id: "SYNTHETIC_TOKEN" }, "token", {
        SYNTHETIC_TOKEN: "undefined",
      }),
    ).toEqual([
      expect.objectContaining({ fixHint: expect.stringContaining("external secret source") }),
    ]);
  });

  it("accepts a real token that merely contains the word undefined", async () => {
    expect(await detectFindings("undefined-but-actually-a-long-real-token")).toEqual([]);
  });
});
