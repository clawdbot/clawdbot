// Control UI tests cover realtime talk conversation behavior.
import { describe, expect, it } from "vitest";
import {
  createRealtimeTalkConversationState,
  finishRealtimeConversationEntry,
  updateRealtimeTalkConversation,
} from "./realtime-talk-conversation.ts";

describe("realtime Talk conversation", () => {
  it("inserts spacing between adjacent transcript fragments", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Turn off",
      final: false,
      nowMs: 1,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "the lights",
      final: false,
      nowMs: 2,
    });

    expect(state.entries).toMatchObject([
      { role: "user", text: "Turn off the lights", isStreaming: true },
    ]);
  });

  it("inserts spacing after punctuation-ended transcript fragments", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Ready.",
      final: false,
      nowMs: 1,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "What next?",
      final: false,
      nowMs: 2,
    });

    expect(state.entries).toMatchObject([
      { role: "assistant", text: "Ready. What next?", isStreaming: true },
    ]);
  });

  it("keeps a late final rewrite in the original user bubble", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Can you tack",
      final: false,
      nowMs: 1,
    });
    state = finishRealtimeConversationEntry(state, "user", 2);
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Checking",
      final: false,
      nowMs: 3,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Can you check?",
      final: true,
      nowMs: 4,
    });

    expect(state.entries).toMatchObject([
      { role: "user", text: "Can you check?", isStreaming: false },
      { role: "assistant", text: "Checking", isStreaming: true },
    ]);
  });

  it("creates a new bubble for the next final user turn after assistant output starts", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "First request",
      final: false,
      nowMs: 1,
    });
    state = finishRealtimeConversationEntry(state, "user", 2);
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Checking",
      final: false,
      nowMs: 3,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Second request",
      final: true,
      nowMs: 4,
    });

    expect(state.entries).toMatchObject([
      { role: "user", text: "First request", isStreaming: false },
      { role: "assistant", text: "Checking", isStreaming: false },
      { role: "user", text: "Second request", isStreaming: false },
    ]);
  });

  it("keeps alternating realtime turns as separate bubbles", () => {
    let state = createRealtimeTalkConversationState();

    for (const update of [
      { role: "user" as const, text: "Hey, what time is it?", final: true },
      {
        role: "assistant" as const,
        text: "Let me look into that for you. It's currently 7:55 PM UTC.",
        final: true,
      },
      { role: "user" as const, text: "How's it going?", final: true },
      {
        role: "assistant" as const,
        text: "Great! Ready for the next task. What can I do for you?",
        final: true,
      },
      { role: "user" as const, text: "Turn on the basement lights", final: true },
      { role: "assistant" as const, text: "Got it, let me check on that.", final: true },
    ]) {
      state = updateRealtimeTalkConversation(state, update);
    }

    expect(state.entries).toMatchObject([
      { role: "user", text: "Hey, what time is it?", isStreaming: false },
      {
        role: "assistant",
        text: "Let me look into that for you. It's currently 7:55 PM UTC.",
        isStreaming: false,
      },
      { role: "user", text: "How's it going?", isStreaming: false },
      {
        role: "assistant",
        text: "Great! Ready for the next task. What can I do for you?",
        isStreaming: false,
      },
      { role: "user", text: "Turn on the basement lights", isStreaming: false },
      { role: "assistant", text: "Got it, let me check on that.", isStreaming: false },
    ]);
  });
});
