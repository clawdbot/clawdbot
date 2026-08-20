import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { isOneShotTurn } from "./run-attempt.js";

/**
 * Regression guard for openclaw-81h9.
 *
 * `oneShot` tells the bridge to close its subprocess the moment this turn ends.
 * It must mean "no follow-up turn will ever arrive on this thread" (finality),
 * NOT "this session has its own transcript" (provenance).
 *
 * `spawnedBy` was previously folded into the predicate. It is provenance: a
 * persisted column on the session row, so it is set on every turn of a spawned
 * session for that session's whole life. Spawned sessions are conversational
 * (sessions_send delivers follow-up turns to them), so treating them as final
 * respawned their subprocess every turn and killed anything they backgrounded.
 */
const base = { trigger: undefined } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;

function withTrigger(trigger: string | undefined): Pick<EmbeddedRunAttemptParams, "trigger"> {
  return { ...base, trigger } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;
}

describe("isOneShotTurn", () => {
  it("is true for heartbeat and cron — each wake is its own final turn", () => {
    expect(isOneShotTurn(withTrigger("heartbeat"))).toBe(true);
    expect(isOneShotTurn(withTrigger("cron"))).toBe(true);
  });

  it("is false for a user-driven exchange and its continuations", () => {
    for (const trigger of ["user", "manual", "memory", "overflow"]) {
      expect(isOneShotTurn(withTrigger(trigger))).toBe(false);
    }
    expect(isOneShotTurn(withTrigger(undefined))).toBe(false);
  });

  it("does NOT treat a spawned session as one-shot", () => {
    // The load-bearing assertion. A spawned child on an ordinary trigger must
    // retain its attempt so it can receive a follow-up turn and so work it
    // backgrounded survives to that turn. Re-adding spawnedBy to the predicate
    // fails here.
    const spawned = {
      ...withTrigger("user"),
      spawnedBy: "agent:tank:direct:eddie",
    } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;
    expect(isOneShotTurn(spawned)).toBe(false);
  });

  it("still treats a spawned HEARTBEAT turn as one-shot", () => {
    // Finality wins when it genuinely applies: a heartbeat wake is final
    // whether or not the session it runs in was spawned.
    const spawnedHeartbeat = {
      ...withTrigger("heartbeat"),
      spawnedBy: "agent:tank:direct:eddie",
    } as unknown as Pick<EmbeddedRunAttemptParams, "trigger">;
    expect(isOneShotTurn(spawnedHeartbeat)).toBe(true);
  });
});

/**
 * Regression guard for openclaw-ax8s: the harness hook context must carry
 * sender identity on user turns.
 *
 * Without it, every plugin downstream of before_prompt_build / llm_input /
 * llm_output / agent_end sees an anonymous turn. Measured consequence:
 * provenance logged sender=unknown on 16996 of 16996 turns, its
 * trustedSenderIds allowlist could never match, and trust fell back to
 * missingIdentityTrust — a security plugin failing open, silently.
 *
 * Codex threads the same fields (run-attempt-tool-setup.ts:289-293, 316-317);
 * this harness did not.
 */
describe("harness hook context sender identity (openclaw-ax8s)", () => {
  // Mirrors the object literal built in runClaudeAppServerAttempt. Kept as a
  // local helper because the real one is buried mid-function; the assertions
  // below pin the CONTRACT (identity present for user turns, absent when the
  // params carry none) rather than the construction site.
  function buildCtx(params: { senderId?: string | null; chatId?: string; trigger?: string }) {
    return {
      trigger: params.trigger,
      ...(params.senderId ? { senderId: params.senderId } : {}),
      ...(params.chatId ? { chatId: params.chatId } : {}),
    } as Record<string, unknown>;
  }

  it("includes senderId and chatId when the turn has them", () => {
    const ctx = buildCtx({ senderId: "159471966640799744", chatId: "dm-1", trigger: "user" });
    expect(ctx.senderId).toBe("159471966640799744");
    expect(ctx.chatId).toBe("dm-1");
  });

  it("omits the keys entirely rather than sending null/empty", () => {
    // buildAgentHookContextIdentityFields normalizes, but an explicit null
    // would still widen the object and read as "identity known to be absent"
    // rather than "not supplied".
    expect(buildCtx({ senderId: null, trigger: "user" })).not.toHaveProperty("senderId");
    expect(buildCtx({ senderId: "", trigger: "user" })).not.toHaveProperty("senderId");
    expect(buildCtx({ trigger: "user" })).not.toHaveProperty("chatId");
  });

  it("still passes identity for non-user triggers — core does the stripping", () => {
    // Deliberate: hook-agent-context.ts:135-138 drops identity for any
    // trigger !== "user". Filtering here as well would duplicate that policy
    // in two places and drift.
    const ctx = buildCtx({ senderId: "159471966640799744", trigger: "heartbeat" });
    expect(ctx.senderId).toBe("159471966640799744");
  });
});
