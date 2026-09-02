// Matrix threading tests keep room-affinity coverage isolated from account/env fixtures.
import { describe, expect, it } from "vitest";
import { matrixPlugin } from "./channel.js";
import type { CoreConfig } from "./types.js";

function requireMatrixAutoThreadIdResolver() {
  const resolveAutoThreadId = matrixPlugin.threading?.resolveAutoThreadId;
  if (!resolveAutoThreadId) {
    throw new Error("expected Matrix automatic thread resolver");
  }
  return resolveAutoThreadId;
}

function requireMatrixToolContextTargetMatcher() {
  const matchesToolContextTarget = matrixPlugin.threading?.matchesToolContextTarget;
  if (!matchesToolContextTarget) {
    throw new Error("expected Matrix tool context target matcher");
  }
  return matchesToolContextTarget;
}

describe("matrix message-tool threading", () => {
  it.each([
    {
      name: "the exact current room",
      currentChannelId: "room:!room:example.org",
      target: "room:!room:example.org",
      expected: true,
    },
    {
      name: "an equivalent Matrix room prefix",
      currentChannelId: "matrix:room:!room:example.org",
      target: "channel:!room:example.org",
      expected: true,
    },
    {
      name: "a raw current room id",
      currentChannelId: "!room:example.org",
      target: "matrix:room:!room:example.org",
      expected: true,
    },
    {
      name: "a different room",
      currentChannelId: "room:!room:example.org",
      target: "room:!another:example.org",
      expected: false,
    },
    {
      name: "a room alias without verified room resolution",
      currentChannelId: "room:!room:example.org",
      target: "#room:example.org",
      expected: false,
    },
    {
      name: "a direct user target without verified room identity",
      currentChannelId: "room:!dm:example.org",
      target: "user:@alice:example.org",
      expected: false,
    },
    {
      name: "a room id with different case",
      currentChannelId: "room:!Room:example.org",
      target: "room:!room:example.org",
      expected: false,
    },
    {
      name: "two user targets rather than a room",
      currentChannelId: "user:@alice:example.org",
      target: "user:@alice:example.org",
      expected: false,
    },
  ])("only matches $name by canonical Matrix room identity", (testCase) => {
    const toolContext = {
      currentChannelId: testCase.currentChannelId,
      currentThreadTs: "$thread",
      replyToMode: "off" as const,
    };

    expect(
      requireMatrixToolContextTargetMatcher()({
        target: testCase.target,
        toolContext,
      }),
    ).toBe(testCase.expected);
    expect(
      requireMatrixAutoThreadIdResolver()({
        cfg: {} as CoreConfig,
        to: testCase.target,
        toolContext,
      }),
    ).toBe(testCase.expected ? "$thread" : undefined);
  });

  it.each(["off", "first", "all", "batched"] as const)(
    "preserves an existing Matrix room thread when replyToMode is %s",
    (replyToMode) => {
      expect(
        requireMatrixAutoThreadIdResolver()({
          cfg: {} as CoreConfig,
          to: "room:!room:example.org",
          replyToId: "$reply",
          toolContext: {
            currentChannelId: "matrix:room:!room:example.org",
            currentThreadTs: "$thread",
            replyToMode,
            hasRepliedRef: { value: true },
          },
        }),
      ).toBe("$thread");
    },
  );

  it("does not infer a Matrix room thread without an existing thread root", () => {
    expect(
      requireMatrixAutoThreadIdResolver()({
        cfg: {} as CoreConfig,
        to: "room:!room:example.org",
        toolContext: { currentChannelId: "room:!room:example.org" },
      }),
    ).toBeUndefined();
  });

  it("does not inherit Matrix room threads from another channel provider", () => {
    const toolContext = {
      currentChannelProvider: "slack" as const,
      currentChannelId: "room:!room:example.org",
      currentThreadTs: "$thread",
    };

    expect(
      requireMatrixToolContextTargetMatcher()({
        target: "room:!room:example.org",
        toolContext,
      }),
    ).toBe(false);
    expect(
      requireMatrixAutoThreadIdResolver()({
        cfg: {} as CoreConfig,
        to: "room:!room:example.org",
        toolContext,
      }),
    ).toBeUndefined();
  });

  it("does not infer Matrix DM room identity from a matching user messaging target", () => {
    expect(
      requireMatrixAutoThreadIdResolver()({
        cfg: {} as CoreConfig,
        to: "user:@alice:example.org",
        toolContext: {
          currentChannelProvider: "matrix",
          currentChannelId: "room:!dm:example.org",
          currentMessagingTarget: "user:@alice:example.org",
          currentThreadTs: "$thread",
        },
      }),
    ).toBeUndefined();
  });
});
