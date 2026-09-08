import { describe, expect, it } from "vitest";
import {
  readParticipantIdentity,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";

const invalidIdentity = "Session participant identity is invalid; run openclaw doctor --fix.";

const validIdentities: SessionParticipantIdentity[] = [
  { type: "profile", id: "profile-1" },
  { type: "agent", id: "agent-1" },
  { type: "remote", pluginId: "test-channel", domain: "workspace", idKind: "user", id: "remote-1" },
  { type: "observation", pluginId: null, accountId: null, senderKind: "unknown", id: "observer-1" },
  {
    type: "observation",
    pluginId: "test-channel",
    accountId: "account-1",
    senderKind: "bot",
    id: "bot-1",
  },
  { type: "legacy", actorType: "", source: null, id: "" },
  { type: "legacy", actorType: "", source: "", id: "" },
  { type: "legacy", actorType: "person", source: "old-channel", id: "legacy-1" },
  { type: "profile", id: "  " },
  { type: "profile", id: "λ🦞\u0000tail" },
];

describe("stored participant identity decoding", () => {
  it.each(validIdentities)("preserves the stored fields for $type/$id", (identity) => {
    const { id, ...namespace } = identity;
    expect(readParticipantIdentity(JSON.stringify(namespace), id)).toEqual(identity);
  });

  it("takes the actor id from its stored column without normalizing it", () => {
    expect(readParticipantIdentity('{"type":"profile","id":"ignored"}', " actor ")).toEqual({
      type: "profile",
      id: " actor ",
    });
  });

  it("keeps property order when replacing an invalid namespace id", () => {
    const identity = readParticipantIdentity('{"id":{"ignored":true},"type":"profile"}', " actor ");
    expect(identity).toEqual({ id: " actor ", type: "profile" });
    expect(JSON.stringify(identity)).toBe('{"id":" actor ","type":"profile"}');
  });

  it.each([
    "null",
    "[]",
    "true",
    "42",
    '"profile"',
    "{}",
    '{"type":"unknown"}',
    '{"type":"profile","extra":true}',
    '{"type":"profile","__proto__":{}}',
    '{"type":"profile","constructor":null}',
    '{"type":"profile","prototype":null}',
    '{"type":"remote","pluginId":"test-channel"}',
    '{"type":"observation","pluginId":null,"accountId":null,"senderKind":"invalid"}',
    '{"type":"legacy","actorType":null,"source":null}',
  ])("rejects an invalid namespace with the existing repair guidance: %s", (namespace) => {
    expect(() => readParticipantIdentity(namespace, "actor-1")).toThrowError(
      new Error(invalidIdentity),
    );
  });

  it.each(["", 42, null, undefined, []].map((id) => ({ id })))(
    "rejects an invalid profile actor id: $id",
    ({ id }) => {
      expect(() =>
        Reflect.apply(readParticipantIdentity, undefined, ['{"type":"profile"}', id]),
      ).toThrowError(new Error(invalidIdentity));
    },
  );

  it.each(['{"type":', '{"type":"profile",}', '{"type":"pro\\qfile"}'])(
    "preserves the native JSON syntax error for %s",
    (namespace) => {
      let nativeError: unknown;
      try {
        JSON.parse(namespace);
      } catch (error) {
        nativeError = error;
      }
      if (!(nativeError instanceof SyntaxError)) {
        throw new Error("Fixture must produce a native JSON syntax error");
      }
      expect(() => readParticipantIdentity(namespace, "actor-1")).toThrowError(SyntaxError);
      expect(() => readParticipantIdentity(namespace, "actor-1")).toThrowError(nativeError);
    },
  );
});
