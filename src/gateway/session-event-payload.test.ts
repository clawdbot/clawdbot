import { expect, it } from "vitest";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";

it("projects session actors and explicitly clears absent attribution", () => {
  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:owned",
        kind: "direct",
        updatedAt: 1,
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        participants: [{ type: "human", id: "profile-bob", label: "Bob" }],
        participantCount: 1,
      },
    }),
  ).toMatchObject({
    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
    archivedBy: null,
    participants: [{ type: "human", id: "profile-bob", label: "Bob" }],
    participantCount: 1,
  });

  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:archived",
        kind: "direct",
        updatedAt: 2,
        archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      },
    }),
  ).toMatchObject({
    createdActor: null,
    archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    participants: [],
    participantCount: 0,
  });
});
