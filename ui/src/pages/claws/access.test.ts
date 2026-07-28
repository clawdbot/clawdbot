import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { clawMutationAvailable } from "./access.ts";

function snapshot(scopes: string[], methods: string[]): ApplicationGatewaySnapshot {
  return {
    hello: { auth: { role: "operator", scopes }, features: { methods } },
  } as ApplicationGatewaySnapshot;
}

describe("clawMutationAvailable", () => {
  it("requires both advertised methods and operator.admin", () => {
    const methods = ["claws.add.apply"];
    expect(clawMutationAvailable(snapshot(["operator.read"], methods), methods)).toBe(false);
    expect(clawMutationAvailable(snapshot(["operator.admin"], []), methods)).toBe(false);
    expect(clawMutationAvailable(snapshot(["operator.admin"], methods), methods)).toBe(true);
  });
});
