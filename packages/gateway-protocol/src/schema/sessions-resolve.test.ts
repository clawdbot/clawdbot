import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SessionsResolveCandidateSchema as PublicSessionsResolveCandidateSchema,
  SessionsResolveParamsSchema as PublicSessionsResolveParamsSchema,
  SessionsResolveResultSchema as PublicSessionsResolveResultSchema,
  type SessionsResolveCandidate as PublicSessionsResolveCandidate,
  type SessionsResolveParams as PublicSessionsResolveParams,
  type SessionsResolveResult as PublicSessionsResolveResult,
} from "../index.js";
import type * as PublicSchema from "../schema.js";
import { ProtocolSchemas } from "./protocol-schemas.js";
import {
  SessionsResolveCandidateSchema,
  SessionsResolveParamsSchema,
  SessionsResolveResultSchema,
  type SessionsResolveCandidate,
  type SessionsResolveParams,
  type SessionsResolveResult,
} from "./sessions-resolve.js";

describe("sessions.resolve presentation contract", () => {
  const candidate = {
    key: "agent:main:thread:12345678-90ab-4000-8000-000000000001",
    agentId: "main",
    displayName: "Deploy monitor",
    boardFace: "dashboard",
  } as const;

  it("preserves owner-backed public exports, types, and protocol registrations", () => {
    expect(PublicSessionsResolveCandidateSchema).toBe(SessionsResolveCandidateSchema);
    expect(PublicSessionsResolveParamsSchema).toBe(SessionsResolveParamsSchema);
    expect(PublicSessionsResolveResultSchema).toBe(SessionsResolveResultSchema);
    expect(ProtocolSchemas.SessionsResolveCandidate).toBe(SessionsResolveCandidateSchema);
    expect(ProtocolSchemas.SessionsResolveParams).toBe(SessionsResolveParamsSchema);
    expect(ProtocolSchemas.SessionsResolveResult).toBe(SessionsResolveResultSchema);
    expectTypeOf<PublicSessionsResolveCandidate>().toEqualTypeOf<SessionsResolveCandidate>();
    expectTypeOf<PublicSessionsResolveParams>().toEqualTypeOf<SessionsResolveParams>();
    expectTypeOf<PublicSessionsResolveResult>().toEqualTypeOf<SessionsResolveResult>();
    expectTypeOf<PublicSchema.SessionsResolveResult>().toEqualTypeOf<SessionsResolveResult>();
  });

  it("accepts optional bounded presentation facts on unique and ambiguous results", () => {
    expect(Value.Check(SessionsResolveCandidateSchema, candidate)).toBe(true);
    expect(Value.Check(SessionsResolveResultSchema, { ok: true, ...candidate })).toBe(true);
    expect(
      Value.Check(SessionsResolveResultSchema, {
        ok: true,
        key: candidate.key,
        agentId: candidate.agentId,
      }),
    ).toBe(true);
    expect(Value.Check(SessionsResolveResultSchema, { ok: false })).toBe(true);
    expect(
      Value.Check(SessionsResolveResultSchema, {
        ok: false,
        candidates: Array.from({ length: 10 }, () => candidate),
      }),
    ).toBe(true);
  });

  it("rejects invalid faces, unexpected facts, and more than ten candidates", () => {
    expect(Value.Check(SessionsResolveCandidateSchema, { ...candidate, boardFace: "grid" })).toBe(
      false,
    );
    expect(Value.Check(SessionsResolveCandidateSchema, { ...candidate, sessionId: "opaque" })).toBe(
      false,
    );
    expect(
      Value.Check(SessionsResolveResultSchema, {
        ok: false,
        candidates: Array.from({ length: 11 }, () => candidate),
      }),
    ).toBe(false);
  });
});
