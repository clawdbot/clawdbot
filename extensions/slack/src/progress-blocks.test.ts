import { describe, expect, it } from "vitest";
import { buildSlackProgressDraftBlocks } from "./progress-blocks.js";

function progressLine(index: number) {
  return {
    kind: "tool" as const,
    icon: "🛠️",
    label: `Exec ${index}`,
    detail: `run ${index}`,
    text: `🛠️ Exec ${index}: run ${index}`,
  };
}

function expectProgressBlock(block: unknown, label: string, detail: string) {
  expect(block).toEqual({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `🛠️ *${label}*` },
      { type: "mrkdwn", text: detail },
    ],
  });
}

describe("buildSlackProgressDraftBlocks", () => {
  it("renders structured progress lines as compact Block Kit fields", () => {
    expect(
      buildSlackProgressDraftBlocks({
        label: "Shelling...",
        lines: [
          {
            kind: "tool",
            icon: "🛠️",
            label: "Exec",
            detail: "run tests",
            text: "🛠️ Exec: run tests",
            toolName: "exec",
          },
        ],
      }),
    ).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Shelling...*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "🛠️ *Exec*" },
          { type: "mrkdwn", text: "run tests" },
        ],
      },
    ]);
  });

  it("uses the configured max line chars for rich progress details", () => {
    const blocks = buildSlackProgressDraftBlocks({
      maxLineChars: 64,
      lines: [
        {
          kind: "tool",
          icon: "🛠️",
          label: "Exec",
          detail: "run tests in /Users/example/Projects/openclaw/packages/very/deep/path/example",
          text: "🛠️ Exec: run tests in /Users/example/Projects/openclaw/packages/very/deep/path/example",
        },
      ],
    });

    expect(blocks?.[0]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "🛠️ *Exec*" },
        {
          type: "mrkdwn",
          text: "run tests in /Users/example/P…aw/packages/very/deep/path/example",
        },
      ],
    });
  });

  it("keeps newest rich progress lines when capping Slack blocks", () => {
    const blocksWithLabel = buildSlackProgressDraftBlocks({
      label: "Shelling...",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(blocksWithLabel).toHaveLength(50);
    expectProgressBlock(blocksWithLabel?.[0], "Exec 10", "run 10");
    expectProgressBlock(blocksWithLabel?.at(-1), "Exec 59", "run 59");

    const blocksWithoutLabel = buildSlackProgressDraftBlocks({
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(blocksWithoutLabel).toHaveLength(50);
    expectProgressBlock(blocksWithoutLabel?.[0], "Exec 10", "run 10");
    expectProgressBlock(blocksWithoutLabel?.at(-1), "Exec 59", "run 59");
  });
});
