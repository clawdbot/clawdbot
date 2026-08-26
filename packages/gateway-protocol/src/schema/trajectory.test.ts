import type { Static } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SessionsTrajectoryDetailParamsSchema,
  SessionsTrajectoryPageParamsSchema,
  type SessionsTrajectoryDetailParams,
  type SessionsTrajectoryPageParams,
} from "./trajectory.js";

describe("trajectory protocol", () => {
  it("bounds tail-page requests and rejects undeclared fields", () => {
    expect(
      Value.Check(SessionsTrajectoryPageParamsSchema, {
        sessionKey: "agent:main:main",
        cursor: "opaque-cursor",
        limit: 200,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionsTrajectoryPageParamsSchema, {
        sessionKey: "agent:main:main",
        limit: 201,
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionsTrajectoryPageParamsSchema, {
        sessionKey: "agent:main:main",
        rawTranscript: true,
      }),
    ).toBe(false);
  });

  it("requires stable semantic identity for detail reads", () => {
    expect(
      Value.Check(SessionsTrajectoryDetailParamsSchema, {
        sessionKey: "agent:main:main",
        recordId: "transcript:message-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionsTrajectoryDetailParamsSchema, {
        sessionKey: "agent:main:main",
        requestNumber: 3,
      }),
    ).toBe(false);
  });

  it("derives request types directly from their schemas", () => {
    expectTypeOf<SessionsTrajectoryPageParams>().toEqualTypeOf<
      Static<typeof SessionsTrajectoryPageParamsSchema>
    >();
    expectTypeOf<SessionsTrajectoryDetailParams>().toEqualTypeOf<
      Static<typeof SessionsTrajectoryDetailParamsSchema>
    >();
  });
});
