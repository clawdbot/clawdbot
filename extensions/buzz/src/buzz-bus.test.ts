import { finalizeEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_NORMAL_MESSAGE_KIND,
  buildBuzzMessageTags,
  formatBuzzMessageForAgent,
  parseBuzzMessageEvent,
} from "./message-event.js";
import { parseBuzzAuthTag } from "./relay-auth.js";

const BUZZ_RICH_MESSAGE_KIND = 40_002;
const SECRET_KEY = Uint8Array.from(
  Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
);

describe("Buzz message events", () => {
  it("parses NIP-29 channel and NIP-10 thread tags", () => {
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1_700_000_000,
        content: "hello OpenClaw",
        tags: [
          ["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
          ["e", "root-id", "", "root"],
          ["e", "reply-id", "", "reply"],
          ["p", "mentioned-pubkey"],
        ],
      },
      SECRET_KEY,
    );

    expect(parseBuzzMessageEvent(event)).toMatchObject({
      id: event.id,
      kind: BUZZ_NORMAL_MESSAGE_KIND,
      text: "hello OpenClaw",
      channelId: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
      threadId: "root-id",
      replyToId: "reply-id",
      mentionedPubkeys: ["mentioned-pubkey"],
    });
  });

  it("parses Buzz rich-content messages", () => {
    const event = finalizeEvent(
      {
        kind: BUZZ_RICH_MESSAGE_KIND,
        created_at: 1_700_000_000,
        content: "**hello** OpenClaw",
        tags: [["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"]],
      },
      SECRET_KEY,
    );

    expect(parseBuzzMessageEvent(event)).toMatchObject({
      kind: BUZZ_RICH_MESSAGE_KIND,
      text: "**hello** OpenClaw",
    });
  });

  it("parses and formats Buzz structured diff events", () => {
    const event = finalizeEvent(
      {
        kind: BUZZ_DIFF_MESSAGE_KIND,
        created_at: 1_700_000_000,
        content: "@@ -1 +1 @@\n-old\n+new",
        tags: [
          ["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
          ["repo", "https://github.com/openclaw/openclaw"],
          ["commit", "abcdef1234567890"],
          ["file", "extensions/buzz/src/message-event.ts"],
          ["parent-commit", "1234567890abcdef"],
          ["branch", "feature/buzz", "main"],
          ["pr", "113419"],
          ["l", "typescript"],
          ["description", "Preserve\nstructured diff context"],
          ["truncated", "true"],
          ["alt", "Buzz plugin diff"],
          ["e", "root-id", "", "root"],
          ["e", "reply-id", "", "reply"],
        ],
      },
      SECRET_KEY,
    );

    const message = parseBuzzMessageEvent(event);
    expect(message).toMatchObject({
      kind: BUZZ_DIFF_MESSAGE_KIND,
      threadId: "root-id",
      replyToId: "reply-id",
      diff: {
        repoUrl: "https://github.com/openclaw/openclaw",
        commitSha: "abcdef1234567890",
        filePath: "extensions/buzz/src/message-event.ts",
        parentCommitSha: "1234567890abcdef",
        sourceBranch: "feature/buzz",
        targetBranch: "main",
        pullRequestNumber: 113419,
        language: "typescript",
        description: "Preserve\nstructured diff context",
        truncated: true,
        altText: "Buzz plugin diff",
      },
    });
    expect(message && formatBuzzMessageForAgent(message)).toBe(
      [
        "[Buzz structured diff]",
        "Repository: https://github.com/openclaw/openclaw",
        "Commit: abcdef1234567890",
        "Parent commit: 1234567890abcdef",
        "File: extensions/buzz/src/message-event.ts",
        "Branches: feature/buzz -> main",
        "Pull request: #113419",
        "Language: typescript",
        "Description: Preserve structured diff context",
        "Alt text: Buzz plugin diff",
        "Truncated: yes",
        "",
        "Unified diff:",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
    const boundaryContext = formatBuzzMessageForAgent({
      ...message!,
      diff: {
        ...message!.diff!,
        description: `${"a".repeat(252)}😀tail`,
      },
    });
    expect(Buffer.from(boundaryContext, "utf8").toString("utf8")).toBe(boundaryContext);
  });

  it("ignores non-channel events", () => {
    const event = finalizeEvent(
      { kind: 9, created_at: 1_700_000_000, content: "hello", tags: [] },
      SECRET_KEY,
    );
    expect(parseBuzzMessageEvent(event)).toBeNull();
  });

  it("rejects unsupported, blank, oversized, and malformed diff events", () => {
    const sign = (kind: number, content: string, tags: string[][]) =>
      finalizeEvent({ kind, created_at: 1_700_000_000, content, tags }, SECRET_KEY);
    const room = ["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"];

    expect(parseBuzzMessageEvent(sign(1, "hello", [room]))).toBeNull();
    expect(parseBuzzMessageEvent(sign(BUZZ_RICH_MESSAGE_KIND, " \n ", [room]))).toBeNull();
    expect(
      parseBuzzMessageEvent(sign(BUZZ_NORMAL_MESSAGE_KIND, "x".repeat(256 * 1024 + 1), [room])),
    ).toBeNull();
    expect(
      parseBuzzMessageEvent(
        sign(BUZZ_DIFF_MESSAGE_KIND, "diff", [
          room,
          ["repo", "https://github.com/openclaw/openclaw"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseBuzzMessageEvent(
        sign(BUZZ_DIFF_MESSAGE_KIND, "x".repeat(60 * 1024 + 1), [
          room,
          ["repo", "https://github.com/openclaw/openclaw"],
          ["commit", "abcdef1"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseBuzzMessageEvent(
        sign(BUZZ_NORMAL_MESSAGE_KIND, "hello", [
          room,
          ...Array.from({ length: 51 }, (_, index) => ["p", index.toString(16).padStart(64, "0")]),
        ]),
      ),
    ).toBeNull();
  });

  it("builds direct and nested reply tags like the Buzz SDK", () => {
    expect(
      buildBuzzMessageTags({
        channelId: "channel-id",
        threadId: "root-id",
      }),
    ).toEqual([
      ["h", "channel-id"],
      ["e", "root-id", "", "reply"],
    ]);
    expect(
      buildBuzzMessageTags({
        channelId: "channel-id",
        threadId: "root-id",
        replyToId: "parent-id",
      }),
    ).toEqual([
      ["h", "channel-id"],
      ["e", "root-id", "", "root"],
      ["e", "parent-id", "", "reply"],
    ]);
  });

  it("validates the Buzz NIP-OA authentication tag shape", () => {
    expect(parseBuzzAuthTag('["auth","pubkey","kind=9","signature"]')).toEqual([
      "auth",
      "pubkey",
      "kind=9",
      "signature",
    ]);
    expect(() => parseBuzzAuthTag('["token","value"]')).toThrow("Buzz authTag must be");
  });
});
