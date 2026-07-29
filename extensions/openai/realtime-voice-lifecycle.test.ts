import { describe, expect, it } from "vitest";
import { OpenAIRealtimeVoiceLifecycle } from "./realtime-voice-lifecycle.js";

describe("OpenAIRealtimeVoiceLifecycle", () => {
  it("moves a connection from connecting to ready", () => {
    const lifecycle = new OpenAIRealtimeVoiceLifecycle();
    const connection = lifecycle.connect();

    expect(lifecycle.phase()).toBe("connecting");
    expect(lifecycle.acceptsEvents(connection)).toBe(true);
    expect(lifecycle.ready(connection)).toBe(true);
    expect(lifecycle.phase()).toBe("ready");
    expect(lifecycle.isReady()).toBe(true);
    expect(lifecycle.ready(connection)).toBe(false);
  });

  it("owns retry attempts and resets them only after provider readiness", () => {
    const lifecycle = new OpenAIRealtimeVoiceLifecycle();
    const first = lifecycle.connect();

    expect(lifecycle.retry(first, 2)).toMatchObject({ attempt: 1 });
    const second = lifecycle.reconnect(first);
    expect(second).toBeDefined();
    if (!second) {
      throw new Error("expected a retry connection");
    }

    expect(lifecycle.retry(second, 2)).toMatchObject({ attempt: 2 });
    const third = lifecycle.reconnect(second);
    expect(third).toBeDefined();
    if (!third) {
      throw new Error("expected a second retry connection");
    }
    expect(lifecycle.retry(third, 2)).toBe("exhausted");

    expect(lifecycle.ready(third)).toBe(true);
    expect(lifecycle.retry(third, 2)).toMatchObject({ attempt: 1 });
  });

  it("ignores events from connections replaced by retry or explicit connect", () => {
    const lifecycle = new OpenAIRealtimeVoiceLifecycle();
    const first = lifecycle.connect();
    lifecycle.retry(first, 1);
    const retry = lifecycle.reconnect(first);
    expect(retry).toBeDefined();
    if (!retry) {
      throw new Error("expected a retry connection");
    }

    expect(lifecycle.ready(first)).toBe(false);
    expect(lifecycle.close(first, "error")).toBeUndefined();
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.ready(retry)).toBe(true);

    const replacement = lifecycle.connect();
    expect(retry.signal.aborted).toBe(true);
    expect(lifecycle.failure(retry)).toBe(false);
    expect(lifecycle.ready(replacement)).toBe(true);
  });

  it("keeps cancellation idempotent and gives it terminal precedence", () => {
    const lifecycle = new OpenAIRealtimeVoiceLifecycle();
    const connection = lifecycle.connect();

    expect(lifecycle.cancel()).toBe(true);
    expect(connection.signal.aborted).toBe(true);
    expect(lifecycle.acceptsEvents(connection)).toBe(false);
    expect(lifecycle.cancel()).toBe(false);
    expect(lifecycle.failure(connection)).toBe(false);
    expect(lifecycle.terminalOutcome(connection)).toBe("completed");
    expect(lifecycle.close(connection, "error")).toBe("completed");
    expect(lifecycle.close(connection, "completed")).toBeUndefined();
  });

  it("keeps failure terminal when cancel and close arrive late", () => {
    const lifecycle = new OpenAIRealtimeVoiceLifecycle();
    const connection = lifecycle.connect();

    expect(lifecycle.failure(connection)).toBe(true);
    expect(lifecycle.cancel()).toBe(false);
    expect(lifecycle.close(connection, "completed")).toBe("error");
    expect(lifecycle.close(connection, "error")).toBeUndefined();
  });
});
