import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamOpenAICompletions, streamOpenAIResponses } from "@openclaw/ai/internal/openai";
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
import type { Context, Model } from "../../../llm/types.js";
import {
  appendUserTurnTranscriptMessage,
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  type UserTurnInput,
} from "../../../sessions/user-turn-transcript.js";
import { summarizeMessages } from "../../cache-trace.js";
import {
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  relocateCurrentRuntimeContextCarrierToTail,
} from "../../internal-runtime-context.js";
import { normalizeMessagesForLlmBoundary } from "./attempt.llm-boundary.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AgentMsg = Parameters<typeof normalizeMessagesForLlmBoundary>[0][number];

const TZ = "UTC";
// Payload capture stops before transport, but the provider helper still
// requires this option. Keep the fixture as joined inert text so scanners do
// not treat it as credential material.
const TEST_PROVIDER_OPTION_VALUE = ["fixture", "transport", "value"].join("-");

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

function requiredTimestampPrefix(timestamp: number): string {
  const prefix = buildTimestampPrefix(new Date(timestamp), { timezone: TZ });
  if (!prefix) {
    throw new Error("expected timestamp prefix");
  }
  return prefix;
}

const EXPECTED_PREFIX_TURN1 = requiredTimestampPrefix(TS_TURN1);
const EXPECTED_PREFIX_TURN2 = requiredTimestampPrefix(TS_TURN2);

const OPENAI_COMPLETIONS_MODEL = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;

const OPENAI_RESPONSES_MODEL = {
  ...OPENAI_COMPLETIONS_MODEL,
  api: "openai-responses",
} satisfies Model<"openai-responses">;

async function captureOpenAICompletionsPayload(
  messages: AgentMsg[],
): Promise<Record<string, unknown>> {
  let capturedPayload: Record<string, unknown> | undefined;
  const stream = streamOpenAICompletions(
    OPENAI_COMPLETIONS_MODEL,
    {
      systemPrompt: "Stable system prompt",
      messages: normalizeMessagesForLlmBoundary(messages, { timezone: TZ }) as Context["messages"],
    },
    {
      apiKey: TEST_PROVIDER_OPTION_VALUE,
      cacheRetention: "none",
      onPayload(payload) {
        capturedPayload = payload as Record<string, unknown>;
        throw new Error("stop after payload capture");
      },
    },
  );

  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(capturedPayload).toBeDefined();
  return capturedPayload!;
}

async function captureOpenAIResponsesPayload(
  messages: AgentMsg[],
): Promise<Record<string, unknown>> {
  let capturedPayload: Record<string, unknown> | undefined;
  const stream = streamOpenAIResponses(
    OPENAI_RESPONSES_MODEL,
    {
      systemPrompt: "Stable system prompt",
      messages: normalizeMessagesForLlmBoundary(messages, { timezone: TZ }) as Context["messages"],
    },
    {
      apiKey: TEST_PROVIDER_OPTION_VALUE,
      cacheRetention: "none",
      onPayload(payload) {
        capturedPayload = payload as Record<string, unknown>;
        throw new Error("stop after payload capture");
      },
    },
  );

  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(capturedPayload).toBeDefined();
  return capturedPayload!;
}

function firstTwoProviderMessages(payload: Record<string, unknown>): unknown[] {
  const messages = payload.messages ?? payload.input;
  expect(Array.isArray(messages)).toBe(true);
  return (messages as unknown[]).slice(0, 2);
}

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

  it("keeps the OpenAI Chat Completions provider prefix stable with timestamps enabled", async () => {
    const rawText = "Post-fix cache test ping 1 of 2";
    const currentPayload = await captureOpenAICompletionsPayload([
      currentUserMsg(rawText, TS_TURN1),
    ]);
    const historicalPayload = await captureOpenAICompletionsPayload([
      storedUserMsg(rawText, TS_TURN1),
      ASSISTANT_MSG,
      currentUserMsg("Post-fix cache test ping 2 of 2", TS_TURN2),
    ]);

    const expectedTurn1 = `${EXPECTED_PREFIX_TURN1}${rawText}`;
    const currentStablePrefix = firstTwoProviderMessages(currentPayload);
    const historicalStablePrefix = firstTwoProviderMessages(historicalPayload);

    expect(JSON.stringify(currentStablePrefix)).toBe(JSON.stringify(historicalStablePrefix));
    expect(currentStablePrefix[1]).toEqual({ role: "user", content: expectedTurn1 });
    expect(historicalStablePrefix[1]).toEqual({ role: "user", content: expectedTurn1 });

    const historicalBytes = JSON.stringify(historicalPayload);
    expect(historicalBytes.indexOf(EXPECTED_PREFIX_TURN2)).toBeGreaterThan(
      historicalBytes.indexOf(expectedTurn1),
    );
  });

  it("keeps the OpenAI Responses provider prefix stable with timestamps enabled", async () => {
    const rawText = "Post-fix cache test ping 1 of 2";
    const currentPayload = await captureOpenAIResponsesPayload([currentUserMsg(rawText, TS_TURN1)]);
    const historicalPayload = await captureOpenAIResponsesPayload([
      storedUserMsg(rawText, TS_TURN1),
      ASSISTANT_MSG,
      currentUserMsg("Post-fix cache test ping 2 of 2", TS_TURN2),
    ]);

    const expectedTurn1 = `${EXPECTED_PREFIX_TURN1}${rawText}`;
    const currentStablePrefix = firstTwoProviderMessages(currentPayload);
    const historicalStablePrefix = firstTwoProviderMessages(historicalPayload);

    expect(JSON.stringify(currentStablePrefix)).toBe(JSON.stringify(historicalStablePrefix));
    expect(currentStablePrefix[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: expectedTurn1 }],
    });
    expect(historicalStablePrefix[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: expectedTurn1 }],
    });

    const historicalBytes = JSON.stringify(historicalPayload);
    expect(historicalBytes.indexOf(EXPECTED_PREFIX_TURN2)).toBeGreaterThan(
      historicalBytes.indexOf(expectedTurn1),
    );
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

describe("append-only late media (issue #99495)", () => {
  it("keeps every sent fingerprint stable and appends one late-media turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-99495-boundary-"));
    const transcriptPath = path.join(dir, "session.jsonl");
    const admittedInput = {
      text: "describe this",
      timestamp: TS_TURN1,
      idempotencyKey: "cache-99495:user",
    };
    let resolveMedia!: (input: UserTurnInput) => void;
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    const mediaInput = new Promise<UserTurnInput>((resolve) => {
      resolveMedia = resolve;
    });
    try {
      const recorder = createUserTurnTranscriptRecorder({
        input: admittedInput,
        resolveInput: async () => {
          markResolverStarted();
          return await mediaInput;
        },
        target: { transcriptPath, sessionId: "session-99495", sessionKey: "main", cwd: dir },
      });
      const persistence = recorder.persistFallback();
      await resolverStarted;
      await appendUserTurnTranscriptMessage({
        transcriptPath,
        input: admittedInput,
        sessionId: "session-99495",
        sessionKey: "main",
        cwd: dir,
      });
      recorder.markRuntimePersisted(recorder.message);
      const admittedRuntimeMessage = mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: currentUserMsg(admittedInput.text, admittedInput.timestamp),
        preparedMessage: recorder.message,
      });
      const sent = normalizeMessagesForLlmBoundary([admittedRuntimeMessage], { timezone: TZ });
      recorder.markSentToProvider?.();
      resolveMedia({
        ...admittedInput,
        media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
      });
      await persistence;
      const persisted = fs
        .readFileSync(transcriptPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message?: AgentMsg })
        .flatMap((entry) => (entry.message ? [entry.message] : []));
      const next = normalizeMessagesForLlmBoundary(persisted, { timezone: TZ });
      const sentSummary = summarizeMessages(sent);
      const nextSummary = summarizeMessages(next);

      expect(nextSummary.messageCount).toBe(sentSummary.messageCount + 1);
      expect(nextSummary.messageFingerprints.slice(0, sentSummary.messageCount)).toEqual(
        sentSummary.messageFingerprints,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps media inline when resolution finishes before serialization", async () => {
    const prepared = createUserTurnTranscriptRecorder({
      input: { text: "describe this", timestamp: TS_TURN1 },
      resolveInput: async () => ({
        text: "describe this",
        timestamp: TS_TURN1,
        media: [{ path: "media://inbound/image.jpg", contentType: "image/jpeg" }],
      }),
      target: { transcriptPath: "/unused/session.jsonl" },
    });
    const resolved = await prepared.resolveMessage();
    const merged = mergePreparedUserTurnMessageForRuntime({
      runtimeMessage: currentUserMsg("describe this", TS_TURN1),
      preparedMessage: resolved,
    });
    prepared.markSentToProvider?.();
    const summary = summarizeMessages(normalizeMessagesForLlmBoundary([merged], { timezone: TZ }));

    expect(summary.messageCount).toBe(1);
    expect(merged).toMatchObject({ MediaPath: "media://inbound/image.jpg" });
  });
});

function runtimeCarrier(content: string, timestamp: number): AgentMsg {
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content,
    display: false,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    timestamp,
  } as unknown as AgentMsg;
}

function isCarrier(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { customType?: unknown }).customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  );
}

function textOf(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const block = content.find(
      (b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text",
    );
    return block ? (block as { text?: string }).text : undefined;
  }
  return undefined;
}

describe("prompt-cache tail carrier for current-turn metadata (issue #100271)", () => {
  const wire = (messages: AgentMsg[]) =>
    relocateCurrentRuntimeContextCarrierToTail(
      normalizeMessagesForLlmBoundary(messages, { timezone: TZ }),
    ) as unknown as Array<Record<string, unknown>>;

  const META = "Conversation info (untrusted metadata):\nsender=Bob";

  it("keeps the active user turn bare, tail-places the carrier, and drops it from replayed history", () => {
    // The runner installs the carrier immediately BEFORE the active user turn;
    // the user turn itself is bare.
    const active: AgentMsg[] = [
      storedUserMsg("earlier", TS_TURN1 - 2000),
      ASSISTANT_MSG,
      runtimeCarrier(META, TS_TURN2),
      currentUserMsg("what does this mean?", TS_TURN2),
    ];
    const wireActive = wire(active);

    // Carrier relocated to the ABSOLUTE tail (the append-only slot).
    expect(isCarrier(wireActive[wireActive.length - 1])).toBe(true);
    // The active user turn sits just before it, BARE and stamped — no metadata.
    const activeUser = wireActive[wireActive.length - 2];
    expect(textOf(activeUser)).toBe(`${requiredTimestampPrefix(TS_TURN2)}what does this mean?`);
    expect(textOf(activeUser)).not.toContain("Conversation info");

    // Next turn: that user message is now historical (bare, no carrier survives).
    const historical: AgentMsg[] = [
      storedUserMsg("earlier", TS_TURN1 - 2000),
      ASSISTANT_MSG,
      storedUserMsg("what does this mean?", TS_TURN2),
      ASSISTANT_MSG,
      currentUserMsg("and then?", TS_TURN2 + 60000),
    ];
    const wireHistorical = wire(historical);

    // No runtime-context carrier remains anywhere in replayed history.
    expect(wireHistorical.some(isCarrier)).toBe(false);
    // The aged user turn is byte-identical to its active form.
    const agedUser = wireHistorical.find((m) => textOf(m)?.endsWith("what does this mean?"));
    expect(JSON.stringify(agedUser)).toBe(JSON.stringify(activeUser));
  });

  it("request N+1 is a strict prefix-extension of request N through the active user turn", () => {
    const turnN: AgentMsg[] = [
      storedUserMsg("q1", TS_TURN1 - 2000),
      ASSISTANT_MSG,
      runtimeCarrier(META, TS_TURN2),
      currentUserMsg("q2", TS_TURN2),
    ];
    const turnN1: AgentMsg[] = [
      storedUserMsg("q1", TS_TURN1 - 2000),
      ASSISTANT_MSG,
      storedUserMsg("q2", TS_TURN2),
      ASSISTANT_MSG,
      runtimeCarrier(META, TS_TURN2 + 60000),
      currentUserMsg("q3", TS_TURN2 + 60000),
    ];
    const wireN = wire(turnN).map((m) => JSON.stringify(m));
    const wireN1 = wire(turnN1).map((m) => JSON.stringify(m));

    // Everything through the turn-N active user turn (q1, reply, q2) is
    // byte-identical in request N+1 — only the trailing carrier differs.
    const sharedPrefixLen = 3;
    expect(wireN1.slice(0, sharedPrefixLen)).toEqual(wireN.slice(0, sharedPrefixLen));
    // In request N the carrier occupies the append-only slot right after q2.
    expect(isCarrier(wire(turnN)[3])).toBe(true);
  });

  it("runtime-only (room-event) inline context is not strip-eligible, so it stays byte-stable in both positions", () => {
    // Runtime-only turns keep their inbound context inline (not in the carrier).
    // That is safe ONLY because room-event/system context is not strip-eligible:
    // the historical strip removes just the buildInboundUserContextPrefix blocks
    // (Conversation info / Reply target / …), which room events never carry. So
    // the inline form is byte-identical active vs historical.
    const roomText = [
      "[OpenClaw room event]",
      "inbound_event_kind: room_event",
      "Room context:\n#1 Alice: hi",
    ].join("\n\n");
    const asCurrent: AgentMsg[] = [currentUserMsg(roomText, TS_TURN2)];
    const asHistorical: AgentMsg[] = [
      storedUserMsg(roomText, TS_TURN2),
      ASSISTANT_MSG,
      currentUserMsg("next", TS_TURN2 + 60000),
    ];
    const cur = normalizeMessagesForLlmBoundary(asCurrent, { timezone: TZ }) as unknown as Array<{
      content?: unknown;
    }>;
    const hist = normalizeMessagesForLlmBoundary(asHistorical, {
      timezone: TZ,
    }) as unknown as Array<{ content?: unknown }>;
    // Byte-identical active vs historical...
    expect(JSON.stringify(cur[0]?.content)).toBe(JSON.stringify(hist[0]?.content));
    // ...and the room context is preserved in both (the strip does not touch it).
    expect(JSON.stringify(hist[0]?.content)).toContain("inbound_event_kind: room_event");
  });
});
