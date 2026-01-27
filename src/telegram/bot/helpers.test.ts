import { describe, expect, it } from "vitest";
import {
  buildTelegramThreadParams,
  buildTypingThreadParams,
  normalizeForwardedContext,
} from "./helpers.js";

describe("buildTelegramThreadParams", () => {
  it("omits General topic thread id for message sends", () => {
    expect(buildTelegramThreadParams(1)).toBeUndefined();
  });

  it("includes non-General topic thread ids", () => {
    expect(buildTelegramThreadParams(99)).toEqual({ message_thread_id: 99 });
  });

  it("normalizes thread ids to integers", () => {
    expect(buildTelegramThreadParams(42.9)).toEqual({ message_thread_id: 42 });
  });
});

describe("buildTypingThreadParams", () => {
  it("returns undefined when no thread id is provided", () => {
    expect(buildTypingThreadParams(undefined)).toBeUndefined();
  });

  it("includes General topic thread id for typing indicators", () => {
    expect(buildTypingThreadParams(1)).toEqual({ message_thread_id: 1 });
  });

  it("normalizes thread ids to integers", () => {
    expect(buildTypingThreadParams(42.9)).toEqual({ message_thread_id: 42 });
  });
});

describe("normalizeForwardedContext", () => {
  it("handles forward_origin users", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "user",
        sender_user: { first_name: "Ada", last_name: "Lovelace", username: "ada", id: 42 },
        date: 123,
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Ada Lovelace (@ada)");
    expect(ctx?.fromType).toBe("user");
    expect(ctx?.fromId).toBe("42");
    expect(ctx?.fromUsername).toBe("ada");
    expect(ctx?.fromTitle).toBe("Ada Lovelace");
    expect(ctx?.date).toBe(123);
  });

  it("handles hidden forward_origin names", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: { type: "hidden_user", sender_user_name: "Hidden Name", date: 456 },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Hidden Name");
    expect(ctx?.fromType).toBe("hidden_user");
    expect(ctx?.fromTitle).toBe("Hidden Name");
    expect(ctx?.date).toBe(456);
  });

  it("handles legacy forwards with signatures", () => {
    const ctx = normalizeForwardedContext({
      forward_from_chat: {
        title: "Moltbot Updates",
        username: "moltbot",
        id: 99,
        type: "channel",
      },
      forward_signature: "Stan",
      forward_date: 789,
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Moltbot Updates (Stan)");
    expect(ctx?.fromType).toBe("legacy_channel");
    expect(ctx?.fromId).toBe("99");
    expect(ctx?.fromUsername).toBe("moltbot");
    expect(ctx?.fromTitle).toBe("Moltbot Updates");
    expect(ctx?.fromSignature).toBe("Stan");
    expect(ctx?.date).toBe(789);
  });

  it("handles legacy hidden sender names", () => {
    const ctx = normalizeForwardedContext({
      forward_sender_name: "Legacy Hidden",
      forward_date: 111,
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Legacy Hidden");
    expect(ctx?.fromType).toBe("legacy_hidden_user");
    expect(ctx?.date).toBe(111);
  });
});
