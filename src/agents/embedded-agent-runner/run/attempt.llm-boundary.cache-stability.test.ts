/**
 * Cache-stability gate for the prompt-cache bust fix (issue #3658).
 *
 * Design under test: SINGLE-SOURCE stamping at the LLM boundary.
 *   - The gateway no longer stamps the live turn; storage is BARE.
 *   - normalizeMessagesForLlmBoundary stamps EVERY user message (active AND
 *     historical) from that message's OWN `timestamp` field, using the
 *     configured timezone — never wall-clock "now".
 *   - Single-text-block content arrays collapse to plain strings so the form
 *     matches the stored (string) historical form.
 *
 * THE REAL ASYMMETRY (what build #1's test missed): on the wire the SAME user
 * message arrives BARE + as an array when it is the CURRENT turn (agent message
 * state / BodyForAgent), but BARE + as a stored string once it has aged into
 * HISTORY. Both must serialize BYTE-IDENTICALLY after the boundary, both stamped
 * from msg.timestamp. This test feeds the bare-current scenario explicitly.
 *
 * Self-contained: no gateway, no provider, no live session.
 */
import { describe, expect, it } from "vitest";
import { stripInboundMetadata } from "../../../auto-reply/reply/strip-inbound-meta.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import { normalizeMessagesForLlmBoundary } from "./attempt.llm-boundary.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AgentMsg = Parameters<typeof normalizeMessagesForLlmBoundary>[0][number];

const TZ = "UTC";

/** A user message as it sits in the JSONL transcript: BARE string + timestamp. */
function storedUserMsg(content: string, timestamp: number): AgentMsg {
  return { role: "user", content, timestamp } as AgentMsg;
}

/**
 * A user message exactly as it arrives in agent message state on the CURRENT
 * turn: BARE text wrapped in a single text block (the SDK's native array form)
 * plus the arrival `timestamp`. No stamp — the gateway no longer adds one.
 */
function currentUserMsg(text: string, timestamp: number): AgentMsg {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMsg;
}

const ASSISTANT_MSG: AgentMsg = {
  role: "assistant",
  content: [{ type: "text", text: "I understand." }],
  timestamp: 500,
} as AgentMsg;

const TS_TURN1 = 1717570800000; // fixed arrival time for turn 1
const TS_TURN2 = 1717570860000; // turn 2 (a minute later — crosses minute boundary)

const EXPECTED_PREFIX_TURN1 = buildTimestampPrefix(new Date(TS_TURN1), { timezone: TZ });

// ---------------------------------------------------------------------------
// THE GATE: bare-current vs bare-historical byte identity
// ---------------------------------------------------------------------------

describe("prompt-cache byte-identity (issue #3658)", () => {
  it("bare current-turn message == same message aged to history (byte-identical, both stamped from msg.timestamp)", () => {
    // This is THE gate. It models the REAL wire asymmetry that the live capture
    // proved: turn 1 sent BARE+array when current, BARE+string when historical.
    //
    // CURRENT send: turn 1 IS the last user message, arriving as an array block
    // with NO stamp (gateway no longer stamps the live turn).
    const rawText = "Post-fix cache test ping 1 of 2";
    const asCurrent: AgentMsg[] = [currentUserMsg(rawText, TS_TURN1)];

    // HISTORICAL send: a new turn 2 has arrived; turn 1 has aged to a stored
    // bare string. Turn 2 itself is the new (bare) current turn.
    const asHistorical: AgentMsg[] = [
      storedUserMsg(rawText, TS_TURN1),
      ASSISTANT_MSG,
      currentUserMsg("Post-fix cache test ping 2 of 2", TS_TURN2),
    ];

    const normalizedCurrent = normalizeMessagesForLlmBoundary(asCurrent, {
      timezone: TZ,
    }) as unknown as Array<{ content?: unknown }>;
    const normalizedHistorical = normalizeMessagesForLlmBoundary(asHistorical, {
      timezone: TZ,
    }) as unknown as Array<{ content?: unknown }>;

    const turn1AsCurrent = JSON.stringify(normalizedCurrent[0]?.content);
    const turn1AsHistorical = JSON.stringify(normalizedHistorical[0]?.content);

    // THE CORE ASSERTION — byte-identical serialization of turn 1 in both sends.
    expect(turn1AsCurrent).toBe(turn1AsHistorical);

    // Both must be the SAME plain stamped string (string form, stamped from
    // turn 1's OWN timestamp), not a bare array and not "now".
    const expected = `${EXPECTED_PREFIX_TURN1}${rawText}`;
    expect(normalizedCurrent[0]?.content).toBe(expected);
    expect(normalizedHistorical[0]?.content).toBe(expected);
    expect(typeof normalizedCurrent[0]?.content).toBe("string");
    expect(typeof normalizedHistorical[0]?.content).toBe("string");
  });

  it("stamp derives from message timestamp, not wall-clock — repeated calls are byte-stable", () => {
    // Same message object (fixed timestamp) → identical serialization regardless
    // of when normalize is called. Guards against any "now"-based drift.
    const msg: AgentMsg[] = [storedUserMsg("Cache test message", TS_TURN1)];

    const call1 = JSON.stringify(normalizeMessagesForLlmBoundary(msg, { timezone: TZ }));
    const call2 = JSON.stringify(normalizeMessagesForLlmBoundary(msg, { timezone: TZ }));

    expect(call1).toBe(call2);
    // And it is in fact stamped from this message's timestamp.
    const out = normalizeMessagesForLlmBoundary(msg, { timezone: TZ }) as unknown as Array<{
      content?: unknown;
    }>;
    expect(out[0]?.content).toBe(`${EXPECTED_PREFIX_TURN1}Cache test message`);
  });

  it("attachment (multi-block) turn stays as array; first text block is stamped", () => {
    // Turns with non-text blocks must NOT collapse to a string (would drop the
    // attachment). The leading text block still gets the per-message stamp.
    const attachmentMsg: AgentMsg = {
      role: "user",
      content: [
        { type: "text", text: "look at this image" },
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" },
        },
      ],
      timestamp: TS_TURN1,
    } as AgentMsg;
    const currentFollowup = currentUserMsg("follow up", TS_TURN2);

    const input: AgentMsg[] = [attachmentMsg, ASSISTANT_MSG, currentFollowup];
    const output = normalizeMessagesForLlmBoundary(input, { timezone: TZ }) as unknown as Array<{
      content?: unknown;
    }>;

    // Attachment turn stays an array of 2 blocks.
    expect(Array.isArray(output[0]?.content)).toBe(true);
    const blocks = output[0]?.content as Array<{ type?: string; text?: string }>;
    expect(blocks.length).toBe(2);
    // First text block stamped from the message's own timestamp.
    expect(blocks[0]?.text).toBe(`${EXPECTED_PREFIX_TURN1}look at this image`);
    // Image block untouched.
    expect(blocks[1]?.type).toBe("image");
    // Plain-text current collapses to a stamped string.
    expect(output[2]?.content).toBe(
      `${buildTimestampPrefix(new Date(TS_TURN2), { timezone: TZ })}follow up`,
    );
  });

  it("does not double-stamp a message that already carries a timestamp envelope", () => {
    // Channel messages (Discord, Telegram) already carry an envelope like
    // `[Sat 2026-06-05 10:30 UTC+8] message`. The boundary guard must skip them
    // so they never grow a second `[…]` prefix.
    const alreadyStamped = "[Sat 2026-06-05 10:30 UTC+8] Hello from Discord";
    const input: AgentMsg[] = [
      storedUserMsg(alreadyStamped, TS_TURN1),
      ASSISTANT_MSG,
      currentUserMsg("current turn", TS_TURN2),
    ];

    const output = normalizeMessagesForLlmBoundary(input, { timezone: TZ }) as unknown as Array<{
      content?: unknown;
    }>;

    const historicalContent = output[0]?.content as string;
    expect(historicalContent).toBe(alreadyStamped);
    expect(historicalContent.match(/^\[/g)?.length ?? 0).toBe(1);
  });

  it("does not stamp a cron message (Current time: marker)", () => {
    const cron = "Current time: 2026-06-05 10:30. Run the scheduled job.";
    const input: AgentMsg[] = [storedUserMsg(cron, TS_TURN1)];
    const output = normalizeMessagesForLlmBoundary(input, { timezone: TZ }) as unknown as Array<{
      content?: unknown;
    }>;
    expect(output[0]?.content).toBe(cron);
  });

  it("historical inbound metadata is stripped (UI-clean) before the timestamp is applied", () => {
    // Historical user turns get their inbound-metadata blocks stripped (same as
    // the original boundary behaviour), then stamped. The current turn keeps its
    // metadata. We only assert the historical strip+stamp here.
    const metaBlock =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"discord"}\n```\n\n';
    const userText = "What is 2+2?";
    const stored = `${metaBlock}${userText}`;

    const input: AgentMsg[] = [
      storedUserMsg(stored, TS_TURN1),
      ASSISTANT_MSG,
      currentUserMsg("next", TS_TURN2),
    ];
    const output = normalizeMessagesForLlmBoundary(input, { timezone: TZ }) as unknown as Array<{
      content?: unknown;
    }>;

    // Metadata stripped, then stamped from the message's own timestamp.
    const expectedStrippedBare = stripInboundMetadata(stored); // "What is 2+2?"
    expect(output[0]?.content).toBe(`${EXPECTED_PREFIX_TURN1}${expectedStrippedBare}`);
  });
});
