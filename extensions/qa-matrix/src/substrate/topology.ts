export type MatrixQaParticipantRole = "driver" | "observer" | "sut";

export type MatrixQaRoomKind = "dm" | "group";

export type MatrixQaTopologyRoomSpec = {
  encrypted?: boolean;
  key: string;
  kind: MatrixQaRoomKind;
  members: MatrixQaParticipantRole[];
  name: string;
  requireMention?: boolean;
};

export type MatrixQaTopologySpec = {
  defaultRoomKey: string;
  rooms: MatrixQaTopologyRoomSpec[];
};

export type MatrixQaProvisionedRoom = {
  encrypted?: boolean;
  key: string;
  kind: MatrixQaRoomKind;
  memberRoles: MatrixQaParticipantRole[];
  memberUserIds: string[];
  name: string;
  requireMention: boolean;
  roomId: string;
};

export type MatrixQaProvisionedTopology = {
  defaultRoomId: string;
  defaultRoomKey: string;
  rooms: MatrixQaProvisionedRoom[];
};

function matrixQaRoomSpecsEqual(left: MatrixQaTopologyRoomSpec, right: MatrixQaTopologyRoomSpec) {
  return (
    left.key === right.key &&
    (left.encrypted === true) === (right.encrypted === true) &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.requireMention === right.requireMention &&
    left.members.length === right.members.length &&
    left.members.every((member, index) => member === right.members[index])
  );
}

export function buildDefaultMatrixQaTopologySpec(params: {
  defaultRoomName: string;
}): MatrixQaTopologySpec {
  return {
    defaultRoomKey: "main",
    rooms: [
      {
        encrypted: false,
        key: "main",
        kind: "group",
        members: ["driver", "observer", "sut"],
        name: params.defaultRoomName,
        requireMention: true,
      },
    ],
  };
}

export function findMatrixQaProvisionedRoom(
  topology: MatrixQaProvisionedTopology,
  key: string,
): MatrixQaProvisionedRoom {
  const room = topology.rooms.find((entry) => entry.key === key);
  if (!room) {
    throw new Error(`Matrix QA topology is missing room "${key}"`);
  }
  return room;
}

export function mergeMatrixQaTopologySpecs(specs: MatrixQaTopologySpec[]): MatrixQaTopologySpec {
  const first = specs[0];
  if (!first) {
    throw new Error("Matrix QA topology merge requires at least one spec");
  }

  const roomByKey = new Map<string, MatrixQaTopologyRoomSpec>();
  for (const spec of specs) {
    if (spec.defaultRoomKey !== first.defaultRoomKey) {
      throw new Error(
        `Matrix QA topology default room mismatch: ${spec.defaultRoomKey} !== ${first.defaultRoomKey}`,
      );
    }
    for (const room of spec.rooms) {
      const existing = roomByKey.get(room.key);
      if (!existing) {
        roomByKey.set(room.key, room);
        continue;
      }
      if (!matrixQaRoomSpecsEqual(existing, room)) {
        throw new Error(`Matrix QA topology room "${room.key}" has conflicting definitions`);
      }
    }
  }

  return {
    defaultRoomKey: first.defaultRoomKey,
    rooms: [...roomByKey.values()],
  };
}
