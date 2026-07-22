import { expect, it } from "vitest";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";

it("projects creator identity and explicitly clears it for ownerless generations", () => {
  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:owned",
        kind: "direct",
        updatedAt: 1,
        createdBy: { id: "profile-ada", label: "Ada" },
      },
    }).createdBy,
  ).toEqual({ id: "profile-ada", label: "Ada" });

  expect(
    buildGatewaySessionEventFields({
      sessionRow: { key: "agent:main:ownerless", kind: "direct", updatedAt: 2 },
    }).createdBy,
  ).toBeNull();
});
