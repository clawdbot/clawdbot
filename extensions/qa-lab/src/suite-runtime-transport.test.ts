import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createScenarioWaitForCondition,
  findFailureOutboundMessage,
  formatTransportTranscript,
  readTransportTranscript,
  waitForOutboundMessage,
  waitForTransportOutboundMessage,
} from "./suite-runtime-transport.js";

describe("qa suite transport helpers", () => {
  it("detects classified failure replies before a success-only outbound predicate matches", () => {
    const state = createQaBusState();
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    const message = findFailureOutboundMessage(state);
    expect(message?.text).toContain("Something went wrong while processing your request.");
  });

  it("fails success-only waitForOutboundMessage calls when a classified failure reply arrives first", async () => {
    const state = createQaBusState();
    const pending = waitForOutboundMessage(
      state,
      (candidate) =>
        candidate.conversation.id === "qa-operator" &&
        candidate.text.includes("Remembered ALPHA-7."),
      5_000,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai/gpt-5.5 with the Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("treats QA channel message delivery failures as failure replies", async () => {
    const state = createQaBusState();
    const pending = waitForOutboundMessage(
      state,
      (candidate) => candidate.text.includes("QA-RESTART"),
      5_000,
    );

    state.addOutboundMessage({
      to: "channel:qa-room",
      text: "⚠️ ✉️ Message failed",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow("Message failed");
  });

  it("fails success-only waitForOutboundMessage calls when internal coordination text leaks", async () => {
    const state = createQaBusState();
    const pending = waitForOutboundMessage(
      state,
      (candidate) => candidate.text.includes("QA_LEAK_OK"),
      5_000,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "checking thread context; then post a tight progress reply here.\nQA_LEAK_OK",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow("checking thread context");
  });

  it("fails success-only waitForOutboundMessage calls when a tool-backed scenario reports missing tools", async () => {
    const state = createQaBusState();
    const pending = waitForOutboundMessage(
      state,
      (candidate) => candidate.text.includes("Status: complete"),
      5_000,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "Read: AGENT.md\nEvidence snippet: Tool read not found\nStatus: blocked",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow("Tool read not found");
  });

  it("fails raw scenario waitForCondition calls when a classified failure reply arrives", async () => {
    const state = createQaBusState();
    const waitForCondition = createScenarioWaitForCondition(state);

    const pending = waitForCondition(
      () =>
        state
          .getSnapshot()
          .messages.findLast(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === "qa-operator" &&
              message.text.includes("ALPHA-7"),
          ),
      5_000,
      10,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai/gpt-5.5 with the Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("fails raw scenario waitForCondition calls even when mixed traffic already exists", async () => {
    const state = createQaBusState();
    state.addInboundMessage({
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "alice",
      senderName: "Alice",
      text: "hello",
    });
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "working on it",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });
    state.addInboundMessage({
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "alice",
      senderName: "Alice",
      text: "ok do it",
    });

    const waitForCondition = createScenarioWaitForCondition(state);
    const pending = waitForCondition(
      () =>
        state
          .getSnapshot()
          .messages.slice(3)
          .findLast(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === "qa-operator" &&
              message.text.includes("mission"),
          ),
      150,
      10,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai/gpt-5.5 with the Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("reads transport transcripts with generic helper names", () => {
    const state = createQaBusState();
    state.addInboundMessage({
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "alice",
      senderName: "Alice",
      text: "hello",
    });
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "working on it",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "done",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    const messages = readTransportTranscript(state, {
      conversationId: "qa-operator",
      direction: "outbound",
    });
    const formatted = formatTransportTranscript(state, {
      conversationId: "qa-operator",
    });

    expect(messages.map((message: { text: string }) => message.text)).toEqual([
      "working on it",
      "done",
    ]);
    expect(formatted).toContain("USER Alice: hello");
    expect(formatted).toContain("ASSISTANT OpenClaw QA: working on it");
  });

  it("waits for outbound replies through the generic transport alias", async () => {
    const state = createQaBusState();
    const pending = waitForTransportOutboundMessage(
      state,
      (candidate) => candidate.conversation.id === "qa-operator" && candidate.text.includes("done"),
      5_000,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "done",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).resolves.toMatchObject({ text: "done" });
  });
});
