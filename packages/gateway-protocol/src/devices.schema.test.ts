// Gateway Protocol tests cover devices.schema behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { DeviceTokenRotateResultSchema } from "./schema/devices.js";

/**
 * Rotation results cross the operator boundary: the Gateway echoes the bearer token
 * only to a device rotating its own token, so `tokenDelivery` is the recorded fact a
 * client reports instead of inferring one from an absent `token`.
 */
describe("DeviceTokenRotateResultSchema", () => {
  const validate = Compile(DeviceTokenRotateResultSchema);
  const base = {
    deviceId: "device-1",
    role: "operator",
    scopes: ["operator.read"],
    rotatedAtMs: 1_700_000_000_000,
  };

  it("accepts an in-band rotation that carries the replacement token", () => {
    expect(validate.Check({ ...base, token: "rotated-token", tokenDelivery: "in-band" })).toBe(
      true,
    );
  });

  it("accepts a cross-device rotation that withholds the token", () => {
    expect(validate.Check({ ...base, tokenDelivery: "withheld-cross-device" })).toBe(true);
  });

  // Gateways released before this field omit it; their responses stay decodable so a
  // newer client pointed at an older Gateway keeps working.
  it("accepts a response from a Gateway that predates tokenDelivery", () => {
    expect(validate.Check({ ...base, token: "rotated-token" })).toBe(true);
    expect(validate.Check(base)).toBe(true);
  });

  it("rejects a delivery value outside the recorded set", () => {
    expect(validate.Check({ ...base, tokenDelivery: "emailed" })).toBe(false);
  });

  it("rejects an empty token so an absent secret is never a blank string", () => {
    expect(validate.Check({ ...base, token: "", tokenDelivery: "in-band" })).toBe(false);
  });

  it("rejects an in-band result without the token it claims to deliver", () => {
    expect(validate.Check({ ...base, tokenDelivery: "in-band" })).toBe(false);
  });

  it("rejects a withheld result that still exposes the token", () => {
    expect(
      validate.Check({
        ...base,
        token: "unexpected-token",
        tokenDelivery: "withheld-cross-device",
      }),
    ).toBe(false);
  });
});
