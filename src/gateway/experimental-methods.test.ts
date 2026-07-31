import { describe, expect, it } from "vitest";
import { isGatewayMethodAvailableForEnv } from "./experimental-methods.js";

describe("isGatewayMethodAvailableForEnv", () => {
  it("hides Claw methods unless the experimental feature is enabled", () => {
    expect(isGatewayMethodAvailableForEnv("claws.status", {})).toBe(false);
    expect(isGatewayMethodAvailableForEnv("claws.add.apply", {})).toBe(false);
    expect(
      isGatewayMethodAvailableForEnv("claws.doctor", {
        OPENCLAW_EXPERIMENTAL_CLAWS: "1",
      }),
    ).toBe(true);
    expect(
      isGatewayMethodAvailableForEnv("claws.remove.apply", {
        OPENCLAW_EXPERIMENTAL_CLAWS: "true",
      }),
    ).toBe(true);
  });

  it("does not gate unrelated methods", () => {
    expect(isGatewayMethodAvailableForEnv("agents.list", {})).toBe(true);
  });
});
