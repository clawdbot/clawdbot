// Candidate ordering is a product contract: shared secrets first, because
// several gateway byte routes (plugin/catalog/workspace icons) reject device
// tokens, and each rejected attempt pays the shared-secret brute-force
// penalty on the gateway (delay escalation, remote IP lockout).
import { describe, expect, it } from "vitest";
import { resolveControlUiAuthCandidates } from "./control-ui-auth.ts";

describe("resolveControlUiAuthCandidates", () => {
  it("orders shared secrets before the hello device token", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "device-token" } } as never,
        settings: { token: "shared-token" },
        password: "shared-password",
      }),
    ).toEqual(["shared-token", "shared-password", "device-token"]);
  });

  it("keeps the device token for pairing-only browsers", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "device-token" } } as never,
        settings: { token: "" },
        password: "",
      }),
    ).toEqual(["device-token"]);
  });
});
