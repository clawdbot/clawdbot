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

it("projects the prepared permission boundary only for an explicit mode", () => {
  const ordinary = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:ordinary",
      kind: "direct",
      sessionRoot: "/workspace/private",
      updatedAt: 3,
    },
  });
  expect(ordinary).toMatchObject({ permissionMode: null });
  expect(ordinary).not.toHaveProperty("sessionRoot");

  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:workspace",
        kind: "direct",
        permissionMode: "workspace",
        sessionRoot: "/workspace/project",
        updatedAt: 4,
      },
    }),
  ).toMatchObject({ permissionMode: "workspace", sessionRoot: "/workspace/project" });
});
