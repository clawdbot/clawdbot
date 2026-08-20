// Candidate ordering follows the live Control UI credential while retaining
// saved-secret fallbacks for stale sessions.
import { describe, expect, it } from "vitest";
import { resolveControlUiAuthCandidates } from "./control-ui-auth.ts";

describe("resolveControlUiAuthCandidates", () => {
  it("orders the hello device token before saved shared secrets", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "device-token" } } as never,
        settings: { token: "shared-token" },
        password: "shared-password",
      }),
    ).toEqual(["device-token", "shared-token", "shared-password"]);
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
