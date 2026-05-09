import { describe, expect, it } from "vitest";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import {
  encodeSlackModalPrivateMetadata,
  parseSlackModalPrivateMetadata,
} from "./modal-metadata.js";

describe("buildSlackBlocksFallbackText", () => {
  it("prefers header text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "header", text: { type: "plain_text", text: "Deploy status" } },
      ] as never),
    ).toBe("Deploy status");
  });

  it("uses image alt text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "image", image_url: "https://example.com/image.png", alt_text: "Latency chart" },
      ] as never),
    ).toBe("Latency chart");
  });

  it("uses generic defaults for file and unknown blocks", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "file", source: "remote", external_id: "F123" },
      ] as never),
    ).toBe("Shared a file");
    expect(buildSlackBlocksFallbackText([{ type: "divider" }] as never)).toBe(
      "Shared a Block Kit message",
    );
  });
});

describe("parseSlackBlocksInput", () => {
  it("returns undefined when blocks are missing", () => {
    expect(parseSlackBlocksInput(undefined)).toBeUndefined();
    expect(parseSlackBlocksInput(null)).toBeUndefined();
  });

  it("accepts blocks arrays", () => {
    const parsed = parseSlackBlocksInput([{ type: "divider" }]);
    expect(parsed).toEqual([{ type: "divider" }]);
  });

  it("accepts JSON blocks strings", () => {
    const parsed = parseSlackBlocksInput(
      '[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]',
    );
    expect(parsed).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]);
  });

  it("rejects invalid block payloads", () => {
    const cases = [
      {
        name: "invalid JSON",
        input: "{bad-json",
        expectedMessage: /valid JSON/i,
      },
      {
        name: "non-array payload",
        input: { type: "divider" },
        expectedMessage: /must be an array/i,
      },
      {
        name: "empty array",
        input: [],
        expectedMessage: /at least one block/i,
      },
      {
        name: "non-object block",
        input: ["not-a-block"],
        expectedMessage: /must be an object/i,
      },
      {
        name: "missing block type",
        input: [{}],
        expectedMessage: /non-empty string type/i,
      },
    ] as const;

    for (const testCase of cases) {
      expect(() => parseSlackBlocksInput(testCase.input), testCase.name).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("parseSlackModalPrivateMetadata", () => {
  it("returns empty object for missing or invalid values", () => {
    expect(parseSlackModalPrivateMetadata(undefined)).toStrictEqual({});
    expect(parseSlackModalPrivateMetadata("")).toStrictEqual({});
    expect(parseSlackModalPrivateMetadata("{bad-json")).toStrictEqual({});
  });

  it("parses known metadata fields", () => {
    expect(
      parseSlackModalPrivateMetadata(
        JSON.stringify({
          sessionKey: "agent:main:slack:channel:C1",
          channelId: "D123",
          channelType: "im",
          userId: "U123",
          ignored: "x",
        }),
      ),
    ).toEqual({
      sessionKey: "agent:main:slack:channel:C1",
      channelId: "D123",
      channelType: "im",
      userId: "U123",
    });
  });
});

describe("encodeSlackModalPrivateMetadata", () => {
  it("encodes only known non-empty fields", () => {
    expect(
      JSON.parse(
        encodeSlackModalPrivateMetadata({
          sessionKey: "agent:main:slack:channel:C1",
          channelId: "",
          channelType: "im",
          userId: "U123",
        }),
      ),
    ).toEqual({
      sessionKey: "agent:main:slack:channel:C1",
      channelType: "im",
      userId: "U123",
    });
  });

  it("throws when encoded payload exceeds Slack metadata limit", () => {
    expect(() =>
      encodeSlackModalPrivateMetadata({
        sessionKey: `agent:main:${"x".repeat(4000)}`,
      }),
    ).toThrow(/cannot exceed 3000 chars/i);
  });
});
