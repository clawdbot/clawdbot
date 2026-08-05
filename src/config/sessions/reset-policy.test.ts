// Session reset policy tests cover defaults, opt-in schedules, and compatibility overrides.
import { describe, expect, it } from "vitest";
import { SessionSchema } from "../zod-schema.session.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset-policy.js";
import { resolveChannelResetConfig } from "./reset.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

describe("session reset policy", () => {
  it.each([
    {
      name: "a long inactivity gap",
      startedAt: new Date(2025, 0, 1, 12, 0, 0, 0).getTime(),
      now: new Date(2026, 0, 1, 12, 0, 0, 0).getTime(),
    },
    {
      name: "a midnight boundary",
      startedAt: new Date(2026, 0, 17, 23, 0, 0, 0).getTime(),
      now: new Date(2026, 0, 18, 5, 0, 0, 0).getTime(),
    },
  ])("keeps the default policy fresh across $name", ({ startedAt, now }) => {
    const policy = resolveSessionResetPolicy({ resetType: "direct" });

    expect(policy.mode).toBe("none");
    expect(
      evaluateSessionFreshness({
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        now,
        policy,
      }),
    ).toEqual({ fresh: true });
  });

  it("honors a pending legacy reset tombstone under the default policy", () => {
    const policy = resolveSessionResetPolicy({ resetType: "direct" });

    expect(evaluateSessionFreshness({ updatedAt: 0, now: DAY_MS, policy })).toEqual({
      fresh: false,
    });
  });

  it("resets an explicit daily policy at its configured hour", () => {
    const now = new Date(2026, 0, 18, 5, 0, 0, 0).getTime();
    const startedAt = new Date(2026, 0, 18, 3, 0, 0, 0).getTime();
    const policy = resolveSessionResetPolicy({
      sessionCfg: { reset: { mode: "daily", atHour: 4 } },
      resetType: "direct",
    });

    expect(
      evaluateSessionFreshness({ updatedAt: startedAt, sessionStartedAt: startedAt, now, policy }),
    ).toMatchObject({ fresh: false, staleReason: "daily" });
  });

  it.each([
    {
      name: "the base reset",
      sessionCfg: { reset: { atHour: 6 } },
      resetType: "direct" as const,
    },
    {
      name: "a type override",
      sessionCfg: { resetByType: { group: { atHour: 6 } } },
      resetType: "group" as const,
    },
    {
      name: "a type override above a disabled base policy",
      sessionCfg: {
        reset: { mode: "none" as const },
        resetByType: { group: { atHour: 6 } },
      },
      resetType: "group" as const,
    },
  ])("preserves the daily fallback when $name omits mode", ({ sessionCfg, resetType }) => {
    expect(resolveSessionResetPolicy({ sessionCfg, resetType })).toMatchObject({
      mode: "daily",
      atHour: 6,
    });
  });

  it("preserves combined daily and idle expiry when an explicit reset omits mode", () => {
    expect(
      resolveSessionResetPolicy({
        sessionCfg: { reset: { idleMinutes: 30 } },
        resetType: "direct",
      }),
    ).toMatchObject({ mode: "daily", idleMinutes: 30 });
  });

  it("inherits an active base mode for partial type overrides", () => {
    expect(
      resolveSessionResetPolicy({
        sessionCfg: {
          reset: { mode: "idle", idleMinutes: 60 },
          resetByType: { group: { idleMinutes: 30 } },
        },
        resetType: "group",
      }),
    ).toMatchObject({ mode: "idle", idleMinutes: 30 });
  });

  it("expires an explicit idle policy after inactivity", () => {
    const now = 10 * HOUR_MS;
    const lastInteractionAt = now - 31 * 60_000;
    const policy = resolveSessionResetPolicy({
      sessionCfg: { reset: { mode: "idle", idleMinutes: 30 } },
      resetType: "direct",
    });

    expect(
      evaluateSessionFreshness({ updatedAt: now, lastInteractionAt, now, policy }),
    ).toMatchObject({ fresh: false, staleReason: "idle" });
  });

  it("applies resetByType only to the matching session type", () => {
    const sessionCfg = {
      resetByType: { group: { mode: "idle" as const, idleMinutes: 30 } },
    };

    expect(resolveSessionResetPolicy({ sessionCfg, resetType: "direct" }).mode).toBe("none");
    expect(resolveSessionResetPolicy({ sessionCfg, resetType: "group" })).toMatchObject({
      mode: "idle",
      idleMinutes: 30,
    });
  });

  it("applies a resetByChannel override ahead of the default policy", () => {
    const sessionCfg = {
      resetByChannel: { discord: { mode: "daily" as const, atHour: 6 } },
    };
    const resetOverride = resolveChannelResetConfig({ sessionCfg, channel: "discord" });

    expect(
      resolveSessionResetPolicy({ sessionCfg, resetType: "direct", resetOverride }),
    ).toMatchObject({ mode: "daily", atHour: 6, configured: true });

    const modeLessSessionCfg = {
      reset: { mode: "none" as const },
      resetByChannel: { discord: { atHour: 7 } },
    };
    const modeLessOverride = resolveChannelResetConfig({
      sessionCfg: modeLessSessionCfg,
      channel: "discord",
    });

    expect(
      resolveSessionResetPolicy({
        sessionCfg: modeLessSessionCfg,
        resetType: "direct",
        resetOverride: modeLessOverride,
      }),
    ).toMatchObject({ mode: "daily", atHour: 7, configured: true });
  });

  it("accepts none in the session schema and ignores reset deadlines", () => {
    const sessionCfg = SessionSchema.parse({
      reset: { mode: "none", atHour: 4, idleMinutes: 30 },
    });
    const policy = resolveSessionResetPolicy({
      sessionCfg: { reset: sessionCfg?.reset },
      resetType: "direct",
    });

    expect(evaluateSessionFreshness({ updatedAt: 1, now: DAY_MS, policy })).toEqual({
      fresh: true,
    });
  });
});
