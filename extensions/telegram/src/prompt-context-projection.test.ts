import { describe, expect, it } from "vitest";
import {
  parseTelegramPromptContextProjection,
  resolveCompleteTelegramPromptContextProjectionIds,
  resolveTelegramPromptContextSource,
  withTelegramPromptContextSource,
  type TelegramPromptContextProjection,
  type TelegramPromptContextProjectionMarker,
} from "./prompt-context-projection.js";

const source = { transcriptMessageId: "assistant-1" };

function completeIds(markers: TelegramPromptContextProjectionMarker[]) {
  return resolveCompleteTelegramPromptContextProjectionIds(markers);
}

describe("Telegram prompt-context projections", () => {
  it("round-trips a valid transcript source through channel data", () => {
    const payload = withTelegramPromptContextSource({ text: "hello" }, source);
    expect(resolveTelegramPromptContextSource(payload)).toEqual(source);
  });

  it.each([
    ["text", { text: "rewritten" }],
    ["whitespace-only text", { text: "hello " }],
    ["media", { text: "hello", mediaUrls: ["https://example.com/new.png"] }],
    ["voice fallback", { text: "hello", audioAsVoice: true, spokenText: "rewritten" }],
  ])("rejects stale transcript provenance after a $0 rewrite", (_name, rewritten) => {
    const payload = withTelegramPromptContextSource({ text: "hello" }, source);
    expect(resolveTelegramPromptContextSource({ ...payload, ...rewritten })).toBeUndefined();
  });

  it("parses valid markers and keeps invalid markers scoped to their transcript", () => {
    expect(parseTelegramPromptContextProjection(undefined)).toBeUndefined();
    expect(
      parseTelegramPromptContextProjection({ ...source, partIndex: -1, finalPart: true }),
    ).toEqual({ kind: "invalid", transcriptMessageId: source.transcriptMessageId });
    expect(
      parseTelegramPromptContextProjection({ ...source, partIndex: 0, finalPart: true }),
    ).toEqual({
      kind: "valid",
      projection: { ...source, partIndex: 0, finalPart: true },
    });
  });

  it("accepts one complete contiguous multipart projection", () => {
    expect(
      completeIds([
        { kind: "valid", projection: { ...source, partIndex: 0, finalPart: false } },
        { kind: "valid", projection: { ...source, partIndex: 1, finalPart: true } },
      ]),
    ).toEqual(new Set([source.transcriptMessageId]));
  });

  it.each([
    {
      name: "part zero is missing",
      parts: [{ ...source, partIndex: 1, finalPart: true }],
    },
    {
      name: "a middle part is missing",
      parts: [
        { ...source, partIndex: 0, finalPart: false },
        { ...source, partIndex: 2, finalPart: true },
      ],
    },
    {
      name: "the final marker is missing",
      parts: [{ ...source, partIndex: 0, finalPart: false }],
    },
    {
      name: "multiple final markers exist",
      parts: [
        { ...source, partIndex: 0, finalPart: true },
        { ...source, partIndex: 1, finalPart: true },
      ],
    },
  ])("rejects an incomplete projection when $name", ({ parts }) => {
    expect(
      completeIds(
        (parts as TelegramPromptContextProjection[]).map((projection) => ({
          kind: "valid",
          projection,
        })),
      ),
    ).toEqual(new Set());
  });

  it("tracks repeated visible messages by transcript identity", () => {
    expect(
      completeIds([
        { kind: "valid", projection: { ...source, partIndex: 0, finalPart: true } },
        {
          kind: "valid",
          projection: {
            transcriptMessageId: "assistant-2",
            partIndex: 0,
            finalPart: true,
          },
        },
      ]),
    ).toEqual(new Set(["assistant-1", "assistant-2"]));
  });

  it("poisons one transcript identity when any marker for it is malformed", () => {
    expect(
      completeIds([
        { kind: "valid", projection: { ...source, partIndex: 0, finalPart: true } },
        { kind: "invalid", transcriptMessageId: source.transcriptMessageId },
      ]),
    ).toEqual(new Set());
  });
});
