import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import {
  buildSlackProgressCardBlocks,
  buildSlackProgressStreamChunks,
  EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
  reconcileSlackNativeTaskChunks,
} from "./progress-blocks.js";

const failedCommand: ChannelProgressDraftLine = {
  kind: "command-output",
  label: "Bash",
  detail: "run checks",
  status: "exit 1",
  text: "🛠️ Bash: run checks · exit 1",
};

function progressLine(index: number) {
  return {
    kind: "tool" as const,
    icon: "🛠️",
    label: `Exec ${index}`,
    detail: `run ${index}`,
    text: `🛠️ Exec ${index}: run ${index}`,
  };
}

function toolLine(detail: string, label = "Exec") {
  return {
    kind: "tool" as const,
    icon: "🛠️",
    label,
    detail,
    text: `🛠️ ${label}: ${detail}`,
    toolName: label.toLowerCase(),
  };
}

function planUpdate(title: string) {
  return { type: "plan_update", title };
}

function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
  extra?: Record<string, unknown>,
) {
  return { type: "task_update", id, title, status, ...extra };
}

describe("Slack progress presentation", () => {
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
      { type: "section", text: { type: "mrkdwn", text: expected } },
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
        text: "In progress: Run `pnpm test` for *checks* &lt;@U123&gt; &amp; &lt;!channel&gt;",
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

  it.each([
    { state: "working" as const, prefix: "" },
    { state: "success" as const, prefix: "Completed: " },
    { state: "error" as const, prefix: "Failed: " },
  ])(
    "renders $state without activity decoration and links only settled cards",
    ({ state, prefix }) => {
      const blocks = buildSlackProgressCardBlocks({
        state,
        title: "Checking the workspace",
        lines: [toolLine("run tests")],
        sessionUrl: "https://example.test/chat/main",
      });

      expect(blocks[0]).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: `${prefix}*Checking the workspace*` },
      });
      expect(blocks).toHaveLength(state === "working" ? 1 : 2);
      if (state !== "working") {
        expect(blocks[1]).toEqual({
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "openclaw:session_link",
              text: { type: "plain_text", text: "Open in OpenClaw" },
              url: "https://example.test/chat/main",
            },
          ],
        });
      }
      expect(
        buildSlackProgressCardBlocks({ state, title: "Checking the workspace", lines: [] }),
      ).toHaveLength(1);
    },
  );

  it("preserves authored commentary and reasoning without generated tool rows", () => {
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
        text: "Compare &lt;#C123&gt; approaches 🔍\nChecking *the fix* &lt;@U123&gt; &amp; &lt;!channel&gt; 🔧",
      },
    });
  });

  it("uses a quiet fallback instead of promoting a tool label into a milestone", () => {
    expect(buildSlackProgressStreamChunks({ lines: [toolLine("run tests")] })).toEqual([
      planUpdate("Working"),
      taskUpdate("openclaw_summary", "Working", "in_progress"),
    ]);
    expect(buildSlackProgressStreamChunks({ title: "Reviewing source 🔍", lines: [] })).toEqual([
      planUpdate("Reviewing source 🔍"),
      taskUpdate("openclaw_summary", "Reviewing source 🔍", "in_progress"),
    ]);
  });

  it("updates the summary in place and retires it when authored milestones arrive", () => {
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({
        title: "Reading source",
        lines: [toolLine("read source")],
      }),
    });
    const revised = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Running checks",
        lines: [toolLine("run tests")],
      }),
    });
    expect(revised.chunks).toEqual([
      planUpdate("Running checks"),
      taskUpdate("openclaw_summary", "Running checks", "in_progress"),
    ]);
    const planned = reconcileSlackNativeTaskChunks({
      previous: revised.snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Running checks",
        lines: [],
        plan: [{ step: "Run tests", status: "in_progress" }],
      }),
    });
    expect(planned.chunks).toEqual([
      taskUpdate("plan_step_1", "Run tests", "in_progress"),
      taskUpdate("openclaw_summary", "Running checks", "complete"),
    ]);
  });

  it("keeps pending approval visible through tool activity and retires it once resolved", () => {
    const approval: ChannelProgressDraftLine = {
      kind: "approval",
      label: "Approval",
      detail: "Run the command",
      status: "requested",
      text: "Approval required",
    };
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({
        title: "Working",
        lines: [approval, toolLine("read source")],
      }),
    });
    expect(first.chunks).toContainEqual(
      taskUpdate("openclaw_attention", "Approval required: Run the command", "pending"),
    );
    const resolved = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Working",
        lines: [toolLine("read source")],
      }),
    });
    expect(resolved.chunks).toEqual([
      taskUpdate("openclaw_attention", "Approval required: Run the command", "complete"),
    ]);
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Working",
      lines: [approval, toolLine("read source")],
    });
    expect(blocks.at(-1)).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Approval required: Run the command" },
    });
    const completed = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Working",
        lines: [approval],
        finalInProgressStatus: "complete",
      }),
    });
    expect(completed.chunks).toEqual([
      taskUpdate("openclaw_summary", "Working", "complete"),
      taskUpdate("openclaw_attention", "Approval required: Run the command", "complete"),
    ]);
    expect(
      buildSlackProgressCardBlocks({ state: "success", title: "Working", lines: [approval] }),
    ).toEqual([{ type: "section", text: { type: "mrkdwn", text: "Completed: *Working*" } }]);
  });

  it.each(["complete", "error"] as const)(
    "settles failed tool attention when the native turn ends as %s",
    (finalInProgressStatus) => {
      const first = reconcileSlackNativeTaskChunks({
        previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
        chunks: buildSlackProgressStreamChunks({
          title: "Checking the workspace",
          lines: [failedCommand],
        }),
      });
      expect(first.chunks).toEqual([
        planUpdate("Checking the workspace"),
        taskUpdate("openclaw_summary", "Checking the workspace", "in_progress"),
        taskUpdate("openclaw_attention", "Bash — run checks — exit 1", "error"),
      ]);
      const final = reconcileSlackNativeTaskChunks({
        previous: first.snapshot,
        chunks: buildSlackProgressStreamChunks({
          title: "Checking the workspace",
          lines: [failedCommand],
          finalInProgressStatus,
        }),
      });
      const attentionTitle =
        finalInProgressStatus === "complete"
          ? "Recovered: Bash — run checks — exit 1"
          : "Bash — run checks — exit 1";
      expect(final.chunks).toEqual([
        taskUpdate("openclaw_summary", "Checking the workspace", finalInProgressStatus),
        ...(finalInProgressStatus === "complete"
          ? [taskUpdate("openclaw_attention", attentionTitle, "complete")]
          : []),
      ]);
      expect(final.snapshot.tasks.get("openclaw_attention")).toEqual({
        title: attentionTitle,
        status: finalInProgressStatus,
      });
    },
  );

  it.each([
    { state: "working", attentionTitle: "Bash — run checks — exit 1" },
    { state: "success", attentionTitle: "Recovered: Bash — run checks — exit 1" },
    { state: "error", attentionTitle: "Bash — run checks — exit 1" },
  ] as const)("renders failed tool attention on a $state card", ({ state, attentionTitle }) => {
    const blocks = buildSlackProgressCardBlocks({
      state,
      title: "Checking the workspace",
      lines: [failedCommand],
    });
    expect(blocks.at(-1)).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: attentionTitle },
    });
  });

  it.each(["complete", "error"] as const)(
    "settles the summary as %s and adds the session source only once",
    (status) => {
      const first = reconcileSlackNativeTaskChunks({
        previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
        chunks: buildSlackProgressStreamChunks({ title: "Checking the workspace", lines: [] }),
      });
      const completion = buildSlackProgressStreamChunks({
        title: "Checking the workspace",
        lines: [],
        finalInProgressStatus: status,
        sessionUrl: "https://example.test/chat/main",
      });
      const final = reconcileSlackNativeTaskChunks({
        previous: first.snapshot,
        chunks: completion,
      });
      expect(final.chunks).toEqual([
        taskUpdate("openclaw_summary", "Checking the workspace", status, {
          sources: [
            { type: "url_source", url: "https://example.test/chat/main", text: "Open in OpenClaw" },
          ],
        }),
      ]);
      expect(
        reconcileSlackNativeTaskChunks({ previous: final.snapshot, chunks: completion }).chunks,
      ).toBeUndefined();
    },
  );

  it("shows terminal failure even when all authored milestones were already completed", () => {
    expect(
      buildSlackProgressStreamChunks({
        title: "Checking the workspace",
        lines: [],
        finalInProgressStatus: "error",
        plan: [{ step: "Run checks", status: "completed" }],
      }),
    ).toEqual([
      planUpdate("Checking the workspace"),
      taskUpdate("plan_step_1", "Run checks", "complete"),
      taskUpdate("openclaw_attention", "Failed", "error"),
    ]);
  });

  it("keeps one stable work summary across a rolling window of tool calls", () => {
    let snapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
    for (let index = 0; index < 60; index += 1) {
      const next = reconcileSlackNativeTaskChunks({
        previous: snapshot,
        chunks: buildSlackProgressStreamChunks({
          title: "Checking the workspace",
          lines: [progressLine(index)],
        }),
      });
      expect([...next.snapshot.tasks.values()]).toEqual([
        { title: "Checking the workspace", status: "in_progress" },
      ]);
      if (index > 0) {
        expect(next.chunks).toBeUndefined();
      }
      snapshot = next.snapshot;
    }
    const complete = reconcileSlackNativeTaskChunks({
      previous: snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Checking the workspace",
        lines: [progressLine(59)],
        finalInProgressStatus: "complete",
      }),
    });
    expect(complete.chunks).toEqual([
      taskUpdate("openclaw_summary", "Checking the workspace", "complete"),
    ]);
  });

  it("does not decorate authored milestones or add a tool inventory and counter footer", () => {
    const blocks = buildSlackProgressCardBlocks({
      state: "working",
      title: "Checking the workspace",
      narration: "Reviewing the changes 🔍",
      plan: [{ step: "Inspect source 🔍", status: "in_progress" }],
      lines: Array.from({ length: 20 }, (_value, index) => progressLine(index)),
    });
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*Checking the workspace*" } },
      { type: "section", text: { type: "mrkdwn", text: "_Reviewing the changes 🔍_" } },
      { type: "section", text: { type: "mrkdwn", text: "In progress: Inspect source 🔍" } },
    ]);
  });

  it("uses typed plan steps instead of tool lines when a plan exists", () => {
    const chunks = buildSlackProgressStreamChunks({
      title: "Implementation",
      lines: [toolLine("legacy fallback")],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Patch code", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });

    expect(chunks).toEqual([
      planUpdate("Implementation"),
      taskUpdate("plan_step_1", "Inspect code", "complete"),
      taskUpdate("plan_step_2", "Patch code", "in_progress"),
      taskUpdate("plan_step_3", "Run tests", "pending"),
    ]);
  });

  it("reconciles renamed and reordered plan steps by rewriting position-keyed tasks", () => {
    const initial = buildSlackProgressStreamChunks({
      title: "Implementation",
      lines: [],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
    const revised = buildSlackProgressStreamChunks({
      title: "Implementation",
      lines: [],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Fix parser bug", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });

    expect(initial).toEqual([
      planUpdate("Implementation"),
      taskUpdate("plan_step_1", "Inspect code", "complete"),
      taskUpdate("plan_step_2", "Run tests", "pending"),
    ]);
    expect(revised).toEqual([
      planUpdate("Implementation"),
      taskUpdate("plan_step_1", "Inspect code", "complete"),
      taskUpdate("plan_step_2", "Fix parser bug", "in_progress"),
      taskUpdate("plan_step_3", "Run tests", "pending"),
    ]);
  });

  it("terminalizes orphaned rows when a plan snapshot shrinks", () => {
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({
        title: "Implementation",
        lines: [],
        plan: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    });
    const shrunk = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({
        title: "Implementation",
        lines: [],
        plan: [{ step: "Inspect code", status: "in_progress" }],
      }),
    });

    expect(shrunk.chunks).toEqual([
      taskUpdate("plan_step_1", "Inspect code", "in_progress"),
      taskUpdate("plan_step_2", "Patch code", "complete"),
      taskUpdate("plan_step_3", "Run tests", "complete"),
    ]);
  });

  it("emits nothing when the snapshot matches what the stream already holds", () => {
    const build = () =>
      buildSlackProgressStreamChunks({
        title: "Implementation",
        lines: [],
        plan: [{ step: "Inspect code", status: "in_progress" }],
      });
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: build(),
    });
    const repeated = reconcileSlackNativeTaskChunks({ previous: first.snapshot, chunks: build() });

    expect(first.chunks).toEqual(build());
    expect(repeated.chunks).toBeUndefined();
    expect(repeated.snapshot).toEqual(first.snapshot);
  });

  it("caps explicit native plan titles to Slack chunk limits", () => {
    const chunks = buildSlackProgressStreamChunks({
      title: `Shelling ${"x".repeat(300)}`,
      lines: [toolLine("run tests")],
    });
    const title =
      chunks?.[0] && typeof chunks[0] === "object" && "title" in chunks[0]
        ? chunks[0].title
        : undefined;

    expect(title).toHaveLength(256);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("does not emit native stream chunks when there are no tasks or title", () => {
    expect(
      buildSlackProgressStreamChunks({
        lines: [],
      }),
    ).toBeUndefined();
  });
});
