import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { buildSlackProgressCardBlocks } from "./progress-blocks.js";
import { itemLine, progressLine, toolLine } from "./progress-blocks.test-helpers.js";

describe("buildSlackProgressCardBlocks", () => {
  it("retains independent approvals and failures in the card attention section", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      lines: [
        { kind: "approval", label: "Approve deploy", status: "requested", text: "Approve deploy" },
        {
          kind: "approval",
          label: "Approve restart",
          status: "requested",
          text: "Approve restart",
        },
        { kind: "command-output", label: "Build", status: "exit 1", text: "Build exit 1" },
        { kind: "command-output", label: "Test", status: "exit 2", text: "Test exit 2" },
      ],
    });
    const text = JSON.stringify(blocks);
    for (const expected of [
      "Approve deploy",
      "Approve restart",
      "Build — exit 1",
      "Test — exit 2",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("preserves authored commentary and reasoning Markdown beside tool activity", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Checking the workspace",
      lines: [
        {
          id: "reasoning",
          kind: "item",
          label: "Reasoning",
          text: "Compare <#C123> approaches 🔍",
        },
        {
          id: "commentary:1",
          kind: "item",
          label: "Update",
          text: "Checking **the fix** <@U123> & <!channel> 🔧",
        },
        toolLine("run tests"),
      ],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "• *Reasoning* — Compare &lt;#C123&gt; approaches 🔍\n• *Update* — Checking *the fix* &lt;@U123&gt; &amp; &lt;!channel&gt; 🔧\n🛠️ *Exec* — run tests",
      },
    });
  });

  it.each([
    ["Run `pnpm test`", "*Run `pnpm test`*"],
    ["Run **bold** checks", "*Run bold checks*"],
    ["Read C:\\path", "*Read C:\\path*"],
    [
      "Check `code` for <@U123> & <!channel>",
      "*Check `code` for &lt;@U123&gt; &amp; &lt;!channel&gt;*",
    ],
  ])("renders authored card title %s inside one bold wrapper", (title, expected) => {
    expect(buildSlackProgressCardBlocks({ state: "working", title, lines: [] })).toEqual([
      { type: "section", text: { type: "mrkdwn", text: `🔄 ${expected}` } },
    ]);
  });

  it("renders authored narration inside one italic wrapper while preserving inline code", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      narration: "Check _x_ and *x* with `pnpm test` for <@U123> & <!channel>",
      lines: [],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Check x and x with `pnpm test` for &lt;@U123&gt; &amp; &lt;!channel&gt;_",
      },
    });
  });

  it("renders authored plan Markdown without activating Slack mentions", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      plan: [
        { step: "Run `pnpm test` for **checks** <@U123> & <!channel>", status: "in_progress" },
      ],
      lines: [],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "▸ Run `pnpm test` for *checks* &lt;@U123&gt; &amp; &lt;!channel&gt;",
      },
    });
  });

  it("escapes only entities in literal attention text", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      lines: [{ ...toolLine("`pnpm test` <@U123> & <!channel>"), status: "exit 1" }],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Exec — `pnpm test` &lt;@U123&gt; &amp; &lt;!channel&gt; — exit 1",
      },
    });
  });

  it.each([7, 50])(
    "keeps approval attention visible beside %s recent activity rows",
    (activityCount) => {
      const blocks = buildSlackProgressCardBlocks({
        state: "working",
        title: "Working",
        maxLineChars: 300,
        lines: [
          {
            kind: "approval",
            label: "Approval",
            text: "Approval required",
            detail: "Run the command",
            status: "requested",
          },
          ...Array.from({ length: activityCount }, (_, index) => ({
            ...progressLine(index),
            detail: "x".repeat(300),
          })),
        ],
      });
      expect(JSON.stringify(blocks)).toContain("Run the command");
    },
  );

  it("renders the working card with narration, plan, one activity block, and live footer", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Implementing",
      narration: "Checking the workspace.",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
      ],
      lines: [toolLine("run tests"), itemLine("prepare the workspace", "Preamble")],
      toolCalls: 3,
      elapsedSeconds: 12,
      diffStat: { files: 4, added: 2, removed: 1 },
    });

    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "🔄 *Implementing*" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "_Checking the workspace._" },
      },
      { type: "section", text: { type: "mrkdwn", text: "✅ Inspect\n▸ Patch" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🛠️ *Exec* — run tests\n• *Preamble* — prepare the workspace",
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "🛠️ 3 tools · 📝 4 files +2 −1 · ⏱ 12s" }],
      },
    ]);
  });

  it.each([
    { state: "success" as const, icon: "✅" },
    { state: "error" as const, icon: "❌" },
  ])(
    "renders $state terminal cards and gates the session action on public URL",
    ({ state, icon }) => {
      const blocks = buildSlackProgressCardBlocks({
        state,
        title: "Implementing",
        lines: [toolLine("run tests")],
        diffStat: { files: 2, added: 1, removed: 1 },
        sessionUrl: "https://team.openclaw.ai/openclaw/chat/main",
      });

      expect(blocks[0]).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: `${icon} *Implementing*` },
      });
      // Finished cards keep the diff stat only: no tool-call/elapsed receipt.
      expect(blocks).toContainEqual({
        type: "context",
        elements: [{ type: "mrkdwn", text: "📝 2 files +1 −1" }],
      });
      expect(blocks.at(-1)).toEqual({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "openclaw:session_link",
            text: { type: "plain_text", text: "Open in OpenClaw" },
            url: "https://team.openclaw.ai/openclaw/chat/main",
          },
        ],
      });

      expect(
        buildSlackProgressCardBlocks({ state, title: "Implementing", lines: [] }),
      ).toHaveLength(1);
    },
  );

  it("keeps the newest activity rows inside one section and the Slack block budget", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
      elapsedSeconds: 1,
    });
    const activity = blocks.find(
      (block) => block.type === "section" && JSON.stringify(block).includes("Exec 59"),
    );

    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(activity).toBeDefined();
    expect(JSON.stringify(activity)).toContain("🛠️ *Exec 59* — run 59");
    expect(JSON.stringify(activity)).not.toContain("Exec 0");
  });

  it.each(["success", "error"] as const)(
    "settles approval and failure text when a card ends as %s",
    (state) => {
      const lines: ChannelProgressDraftLine[] = [
        {
          kind: "approval",
          label: "Approval",
          detail: "Run the command",
          status: "requested",
          text: "Approval required",
        },
        {
          kind: "command-output",
          label: "Bash",
          detail: "run checks",
          status: "exit 1",
          text: "Bash: run checks · exit 1",
        },
      ];
      const working = JSON.stringify(
        buildSlackProgressCardBlocks({ state: "working", title: "Working", lines }),
      );
      expect(working).toContain("Run the command");
      expect(working).toContain("exit 1");
      const finished = JSON.stringify(
        buildSlackProgressCardBlocks({ state, title: "Working", lines }),
      );
      expect(finished).not.toContain("Run the command");
      expect(finished).not.toContain("requested");
      expect(finished.includes("Recovered:")).toBe(state === "success");
      expect(finished).toContain("exit 1");
    },
  );
});
