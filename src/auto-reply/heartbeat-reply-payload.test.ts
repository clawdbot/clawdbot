// Heartbeat reply payload selector tests.
import { describe, expect, it } from "vitest";
import {
  resolveHeartbeatReplyPayload,
  resolveHeartbeatTerminalToolFailure,
} from "./heartbeat-reply-payload.js";
import { setReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyPayload } from "./types.js";

describe("resolveHeartbeatReplyPayload", () => {
  it("returns a single non-array payload unchanged", () => {
    const payload: ReplyPayload = { text: "HEARTBEAT_OK" };
    expect(resolveHeartbeatReplyPayload(payload)).toBe(payload);
  });

  it("returns undefined for undefined input", () => {
    expect(resolveHeartbeatReplyPayload(undefined)).toBeUndefined();
    expect(resolveHeartbeatTerminalToolFailure(undefined)).toBeUndefined();
  });

  it("resolves terminal tool-failure metadata independently of payload order", () => {
    const heartbeat = setReplyPayloadMetadata(
      { text: "HEARTBEAT_OK" },
      { heartbeatTerminalToolFailure: { toolName: "message" } },
    );
    const warning: ReplyPayload = { text: "Message failed", isError: true };

    expect(resolveHeartbeatTerminalToolFailure([heartbeat, warning])).toEqual({
      toolName: "message",
    });
  });

  it("returns the last outbound payload when none are reasoning", () => {
    const first: ReplyPayload = { text: "first" };
    const second: ReplyPayload = { text: "second" };
    expect(resolveHeartbeatReplyPayload([first, second])).toBe(second);
  });

  it("skips a trailing reasoning payload and returns the assistant answer", () => {
    const answer: ReplyPayload = { text: "HEARTBEAT_OK" };
    const reasoning: ReplyPayload = {
      text: "The message is an OpenClaw heartbeat poll. I should check recent chat...",
      isReasoning: true,
    };
    expect(resolveHeartbeatReplyPayload([answer, reasoning])).toBe(answer);
  });

  it("returns undefined when every outbound payload is reasoning", () => {
    const reasoning: ReplyPayload = {
      text: "Deliberating about whether to respond...",
      isReasoning: true,
    };
    expect(resolveHeartbeatReplyPayload([reasoning])).toBeUndefined();
  });

  it("returns undefined for a scalar reasoning payload", () => {
    const reasoning: ReplyPayload = {
      text: "Considering whether the heartbeat needs a reply...",
      isReasoning: true,
    };
    expect(resolveHeartbeatReplyPayload(reasoning)).toBeUndefined();
  });

  it("skips a trailing legacy 'Reasoning:'-prefixed payload and returns the final answer", () => {
    const answer: ReplyPayload = { text: "All clear" };
    const legacyReasoning: ReplyPayload = { text: "Reasoning: because nothing changed" };
    expect(resolveHeartbeatReplyPayload([answer, legacyReasoning])).toBe(answer);
  });

  it("returns undefined for a scalar legacy 'Reasoning:'-prefixed payload", () => {
    const legacyReasoning: ReplyPayload = { text: "Reasoning: because nothing changed" };
    expect(resolveHeartbeatReplyPayload(legacyReasoning)).toBeUndefined();
  });

  it("returns undefined for a scalar blockquoted 'Thinking' reasoning payload", () => {
    const blockquoted: ReplyPayload = { text: "Thinking... _weighing the options_" };
    expect(resolveHeartbeatReplyPayload(blockquoted)).toBeUndefined();
  });

  it("skips a trailing lowercase 'reasoning:' payload and returns the final answer", () => {
    const answer: ReplyPayload = { text: "All clear" };
    const lowercased: ReplyPayload = { text: "reasoning: because nothing changed" };
    expect(resolveHeartbeatReplyPayload([answer, lowercased])).toBe(answer);
  });

  it("returns undefined for a Markdown blockquoted thinking payload", () => {
    const quoted: ReplyPayload = { text: "> thinking... _weighing the options_" };
    expect(resolveHeartbeatReplyPayload(quoted)).toBeUndefined();
  });
});
