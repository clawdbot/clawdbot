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

  it("compacts long rich details independently from the text fallback", () => {
    const blocks = buildSlackProgressDraftBlocks({
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
        { type: "mrkdwn", text: "run tests in /Users/ex…es/very/deep/path/example" },
      ],
    });
  });

  it("keeps newest rich progress lines when capping Slack blocks", () => {
    const blocksWithLabel = buildSlackProgressDraftBlocks({
      label: "Shelling...",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(blocksWithLabel).toHaveLength(50);
    expect(blocksWithLabel?.[0]).toMatchObject({
      type: "section",
      text: { text: "*Shelling...*" },
    });
    expect(blocksWithLabel?.[1]).toMatchObject({
      type: "section",
      fields: [{ text: "🛠️ *Exec 11*" }, { text: "run 11" }],
    });
    expect(blocksWithLabel?.at(-1)).toMatchObject({
      type: "section",
      fields: [{ text: "🛠️ *Exec 59*" }, { text: "run 59" }],
    });

    const blocksWithoutLabel = buildSlackProgressDraftBlocks({
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
    });
    expect(blocksWithoutLabel).toHaveLength(50);
    expect(blocksWithoutLabel?.[0]).toMatchObject({
      type: "section",
      fields: [{ text: "🛠️ *Exec 10*" }, { text: "run 10" }],
    });
    expect(blocksWithoutLabel?.at(-1)).toMatchObject({
      type: "section",
      fields: [{ text: "🛠️ *Exec 59*" }, { text: "run 59" }],
    });
  });
});
