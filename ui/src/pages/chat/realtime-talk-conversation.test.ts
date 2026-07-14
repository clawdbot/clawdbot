// Control UI tests cover realtime talk conversation behavior.
import { describe, expect, it } from "vitest";
import {
  createRealtimeTalkConversationState,
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

  it("inserts spacing after punctuation-ended user transcript fragments", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Ready.",
      final: false,
      nowMs: 1,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "What next?",
      final: false,
      nowMs: 2,
    });

    expect(state.entries).toMatchObject([
      { role: "user", text: "Ready. What next?", isStreaming: true },
    ]);
  });

  it("concatenates streamed assistant deltas verbatim without injecting spaces", () => {
    let state = createRealtimeTalkConversationState();

    const deltas = ["I", "'m", " Chat", "G", "PT", ",", " a", " con", "vers", "ational", " AI"];
    for (const [index, delta] of deltas.entries()) {
      state = updateRealtimeTalkConversation(state, {
        role: "assistant",
        text: delta,
        final: false,
        nowMs: index + 1,
      });
    }

    expect(state.entries).toMatchObject([
      { role: "assistant", text: "I'm ChatGPT, a conversational AI", isStreaming: true },
    ]);
  });

  it("keeps per-character assistant deltas verbatim across punctuation boundaries", () => {
    let state = createRealtimeTalkConversationState();

    for (const [index, char] of "Version 1.2 is on docs.openclaw.ai today.".split("").entries()) {
      state = updateRealtimeTalkConversation(state, {
        role: "assistant",
        text: char,
        final: false,
        nowMs: index + 1,
      });
    }

    expect(state.entries).toMatchObject([
      { role: "assistant", text: "Version 1.2 is on docs.openclaw.ai today.", isStreaming: true },
    ]);
  });

  it("replaces streamed assistant text with the authoritative final transcript", () => {
    let state = createRealtimeTalkConversationState();

    for (const delta of ["I'm Chat", "GPT."]) {
      state = updateRealtimeTalkConversation(state, {
        role: "assistant",
        text: delta,
        final: false,
        nowMs: 1,
      });
    }
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "I'm ChatGPT, nice to meet you.",
      final: true,
      nowMs: 2,
    });

    expect(state.entries).toMatchObject([
      { role: "assistant", text: "I'm ChatGPT, nice to meet you.", isStreaming: false },
    ]);
  });

  it("appends a final assistant fragment that only carries the transcript tail", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Sure, the lights are ",
      final: false,
      nowMs: 1,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "off now.",
      final: true,
      nowMs: 2,
    });

    expect(state.entries).toMatchObject([
      { role: "assistant", text: "Sure, the lights are off now.", isStreaming: false },
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
