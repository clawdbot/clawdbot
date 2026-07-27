// Real-behavior proof that the chat.history budget pipeline emits the
// `payload.large` / `truncated` diagnostic whenever older history is omitted,
// and that the omitted count reflects unique source messages (a message that is
// first replaced and then trimmed is not double-counted). These run the real
// production helpers and capture the real diagnostic event bus output.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { onDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type { DiagnosticPayloadLargeEvent } from "../../infra/diagnostic-events.js";
import { capArrayByJsonBytes } from "../session-transcript-readers.js";
import {
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";

type Captured = DiagnosticPayloadLargeEvent[];

// Mirrors the production sequence in handleChatHistoryRequest: replace oversized
// messages, cap the array by byte budget, enforce the final budget, then report
// omissions. Captures any emitted `payload.large` diagnostic event.
function runHistoryBudgetPipeline(params: {
  messages: unknown[];
  maxHistoryBytes: number;
  perMessageHardCap: number;
}): { emittedCount: number; events: Captured; replacedCount: number; frontCapDropped: number } {
  const { messages, maxHistoryBytes, perMessageHardCap } = params;
  const events: Captured = [];
  const unsubscribe = onDiagnosticEvent((evt) => {
    if (evt.type === "payload.large") {
      events.push(evt);
    }
  });
  try {
    const replaced = replaceOversizedChatHistoryMessages({
      messages,
      maxSingleMessageBytes: perMessageHardCap,
    });
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    const emittedCount = reportOmittedChatHistory({
      originalMessages: messages,
      finalMessages: bounded.messages,
      normalizedBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
      maxHistoryBytes,
      logDebug: () => {},
    });
    return {
      emittedCount,
      events,
      replacedCount: replaced.replacedCount,
      frontCapDropped: replaced.messages.length - capped.length,
    };
  } finally {
    unsubscribe();
  }
}

function textMessage(role: string, text: string): Record<string, unknown> {
  return { role, content: [{ type: "text", text }] };
}

describe("chat.history truncation logging (real diagnostic bus)", () => {
  it("emits a truncated diagnostic when history is trimmed to the last message", () => {
    const big = textMessage("user", "x".repeat(8000));
    const last = textMessage("assistant", "ok");
    const result = runHistoryBudgetPipeline({
      messages: [big, last],
      maxHistoryBytes: 2_000,
      perMessageHardCap: 2_000,
    });

    expect(result.events).toHaveLength(1);
    const event = expectDefined(result.events[0], "result.events[0] test invariant");
    expect(event.surface).toBe("gateway.chat.history");
    expect(event.action).toBe("truncated");
    expect(event.reason).toBe("chat_history_budget");
    expect(event.count).toBe(1);
    expect(result.emittedCount).toBe(1);
  });

  it("emits no diagnostic when nothing is omitted", () => {
    const result = runHistoryBudgetPipeline({
      messages: [textMessage("user", "hello"), textMessage("assistant", "hi")],
      maxHistoryBytes: 1_000_000,
      perMessageHardCap: 1_000_000,
    });

    expect(result.events).toHaveLength(0);
    expect(result.emittedCount).toBe(0);
  });

  it("counts a replaced-then-trimmed message once, not twice", () => {
    // `huge` is oversized so it is replaced with a small placeholder, then the
    // placeholder sits at the front and is dropped by the byte cap. The naive
    // sum of replacedCount + front-cap drops would count `huge` twice.
    const huge = textMessage("user", "h".repeat(8000));
    const big1 = textMessage("assistant", "a".repeat(2000));
    const big2 = textMessage("user", "b".repeat(2000));
    const last = textMessage("assistant", "ok");
    const messages = [huge, big1, big2, last];

    const result = runHistoryBudgetPipeline({
      messages,
      maxHistoryBytes: 4_000,
      perMessageHardCap: 3_000,
    });

    // Scenario preconditions: a message was replaced AND front-capped, so the
    // old additive count would have over-reported.
    expect(result.replacedCount).toBeGreaterThan(0);
    expect(result.frontCapDropped).toBeGreaterThan(0);
    const naiveAdditive = result.replacedCount + result.frontCapDropped;

    // The emitted count equals the number of original messages that lost their
    // verbatim representation, and is strictly less than the double-counting sum.
    expect(result.events).toHaveLength(1);
    expect(expectDefined(result.events[0], "result.events[0] test invariant").count).toBe(
      result.emittedCount,
    );
    expect(result.emittedCount).toBe(2);
    expect(naiveAdditive).toBeGreaterThan(result.emittedCount);
  });
});
